// Private computational fixture. No llama model, context, or inference is created.
#include "gguf.h"
#include "ggml-ssd-policy.h"
#include "nlohmann/json.hpp"
#include <CommonCrypto/CommonDigest.h>
#include <libproc.h>
#include <mach/mach.h>
#include <sys/mount.h>
#include <sys/sysctl.h>
#include <fcntl.h>
#include <unistd.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#ifndef FIXTURE_PATCH_SHA256
#error "Bind to the frozen resource patch"
#endif
using json=nlohmann::ordered_json;
static volatile sig_atomic_t interrupted=0;
static void on_signal(int){interrupted=1;}
static std::atomic<uint64_t> source_read{0},destination_read{0},destination_written{0};
static const auto begun=std::chrono::steady_clock::now();
static constexpr uint64_t limit=512ull*1024*1024;
static constexpr uint64_t chunk=1024*1024,metadata_limit=32*1024*1024;
static void check(bool ok,const char * why){if(!ok)throw std::runtime_error(why);}
static void live(){check(!interrupted && !ggml_ssd_stopped() && std::chrono::steady_clock::now()-begun<std::chrono::minutes(5),"fixture cancelled or deadline expired");}
struct measure_t{uint64_t rss=0,foot=0,available=0;int pressure=0;bool valid=false;};
static measure_t measure(){
    measure_t m;rusage_info_v4 r{};vm_statistics64_data_t v{};vm_size_t page=0;
    const auto host=mach_host_self();mach_msg_type_number_t count=HOST_VM_INFO64_COUNT;
    m.valid=proc_pid_rusage(getpid(),RUSAGE_INFO_V4,(rusage_info_t*)&r)==0 && host_page_size(host,&page)==KERN_SUCCESS &&
        host_statistics64(host,HOST_VM_INFO64,(host_info64_t)&v,&count)==KERN_SUCCESS;
    mach_port_deallocate(mach_task_self(),host);size_t n=sizeof(m.pressure);
    m.valid=m.valid && sysctlbyname("kern.memorystatus_vm_pressure_level",&m.pressure,&n,nullptr,0)==0;
    m.rss=r.ri_resident_size;m.foot=r.ri_phys_footprint;m.available=(uint64_t(v.free_count)+v.inactive_count+v.speculative_count)*page;
    m.valid=m.valid && m.rss && m.foot && page && (m.pressure==1 || m.pressure==2);return m;
}
static json measurement(const measure_t & m){return {{"rssBytes",m.rss},{"physicalFootprintBytes",m.foot},{"availableRamBytes",m.available},{"pressureLevel",m.pressure},{"valid",m.valid}};}
static void headroom(const measure_t & m){check(m.valid && m.rss<=limit && m.foot<=limit && m.available>=512ull*1024*1024,"fixture sampled memory safety stop");}
struct fd_owner {
    int fd=-1;struct stat baseline{};
    ~fd_owner(){if(fd>=0)close(fd);}
    void open_file(const std::string & path,int flags){
        fd=open(path.c_str(),flags|O_CLOEXEC|O_NOFOLLOW,0600);check(fd>=0,"cannot open private fixture descriptor");
        struct statfs fs{};check(fstat(fd,&baseline)==0 && S_ISREG(baseline.st_mode),"regular fixture/source file required");
        check(fstatfs(fd,&fs)==0 && strcmp(fs.f_fstypename,"apfs")==0 && (fs.f_flags&MNT_LOCAL),"local APFS required");
        check(fcntl(fd,F_NOCACHE,1)==0 && fcntl(fd,F_RDAHEAD,0)==0,"strict per-descriptor uncached I/O required");
    }
    void unchanged()const{
        struct stat now{};check(fstat(fd,&now)==0 && now.st_dev==baseline.st_dev && now.st_ino==baseline.st_ino && now.st_size==baseline.st_size &&
          now.st_mtimespec.tv_sec==baseline.st_mtimespec.tv_sec && now.st_mtimespec.tv_nsec==baseline.st_mtimespec.tv_nsec &&
          now.st_ctimespec.tv_sec==baseline.st_ctimespec.tv_sec && now.st_ctimespec.tv_nsec==baseline.st_ctimespec.tv_nsec,"source fingerprint changed");
    }
    void read_at(void * out,size_t n,uint64_t at,bool source)const{
        if(source){unchanged();check(at<=uint64_t(baseline.st_size) && n<=uint64_t(baseline.st_size)-at,"source read outside file");}
        auto * p=static_cast<uint8_t*>(out);while(n){live();auto got=pread(fd,p,std::min<uint64_t>(n,chunk),off_t(at));
          if(got<0 && errno==EINTR)continue;check(got>0,"incomplete uncached fixture read");p+=got;at+=got;n-=got;
          if(source)source_read+=got;else destination_read+=got;}
        if(source)unchanged();
    }
    void write_at(const void * data,size_t n,uint64_t at){const auto * p=static_cast<const uint8_t*>(data);while(n){live();auto got=pwrite(fd,p,std::min<uint64_t>(n,chunk),off_t(at));
        if(got<0 && errno==EINTR)continue;check(got>0,"incomplete private fixture write");p+=got;at+=got;n-=got;destination_written+=got;}}
};
static json fingerprint(const struct stat & s){return {{"device",uint64_t(s.st_dev)},{"inode",uint64_t(s.st_ino)},{"sizeBytes",uint64_t(s.st_size)},
    {"mtimeSeconds",s.st_mtimespec.tv_sec},{"mtimeNanoseconds",s.st_mtimespec.tv_nsec},{"ctimeSeconds",s.st_ctimespec.tv_sec},{"ctimeNanoseconds",s.st_ctimespec.tv_nsec}};}
struct header_reader {
    fd_owner * source;
    std::vector<uint8_t> bytes=std::vector<uint8_t>(chunk);
    uint64_t start=UINT64_MAX,size=0;
};
static size_t header_read(void * user,void * output,uint64_t at,size_t n){
    constexpr uint64_t source_header_end=15823936;
    check(at<=source_header_end && n<=source_header_end-at,"metadata read cap exceeded");
    auto & r=*static_cast<header_reader*>(user);auto * p=static_cast<uint8_t*>(output);
    while(n){if(r.start==UINT64_MAX || at<r.start || at>=r.start+r.size){r.start=at/chunk*chunk;r.size=std::min<uint64_t>(chunk,source_header_end-r.start);
        r.source->read_at(r.bytes.data(),r.size,r.start,true);}
      const auto got=std::min<uint64_t>(n,r.start+r.size-at);memcpy(p,r.bytes.data()+(at-r.start),got);at+=got;p+=got;n-=got;}
    return p-static_cast<uint8_t*>(output);
}
static std::string finish_sha(CC_SHA256_CTX & sha){unsigned char hash[32];check(CC_SHA256_Final(hash,&sha)==1,"SHA256 finalization");char hex[65]{};for(int i=0;i<32;i++)snprintf(hex+2*i,3,"%02x",hash[i]);return hex;}
static std::string digest_range(fd_owner & file,uint64_t offset,uint64_t bytes,std::vector<uint8_t> & buffer,bool source){
    CC_SHA256_CTX sha;check(CC_SHA256_Init(&sha)==1,"SHA256 initialization");
    for(uint64_t at=0;at<bytes;){const auto n=std::min<uint64_t>(chunk,bytes-at);file.read_at(buffer.data(),n,offset+at,source);check(CC_SHA256_Update(&sha,buffer.data(),CC_LONG(n))==1,"SHA256 update");at+=n;}return finish_sha(sha);
}
int main(int argc,char ** argv){
    gguf_context * original=nullptr,*target=nullptr;ggml_context * metadata=nullptr;
    std::atomic<bool> done{false};std::thread watchdog;std::string partial;bool owned_partial=false;
    try{
      check(argc==9 && std::string(argv[1])=="--source" && std::string(argv[3])=="--verified-source-sha256" && std::string(argv[5])=="--output" && std::string(argv[7])=="--report","strict source/verified-digest/output/report arguments required");
      check(std::string(argv[4])=="3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d","caller must provide the completely verified pinned Gemma artifact digest");
      const std::string out=argv[6],report=argv[8];partial=out+".part";
      signal(SIGTERM,on_signal);signal(SIGINT,on_signal);ggml_ssd_start(limit,limit,300000);
      auto initial=measure();headroom(initial);
      watchdog=std::thread([&]{while(!done){if(interrupted || ggml_ssd_stopped() || std::chrono::steady_clock::now()-begun>=std::chrono::minutes(5)){
          fprintf(stderr,"FIXTURE_STOPPED cancellation/deadline\n");std::_Exit(75);}
          auto m=measure();fprintf(stderr,"FIXTURE_SAMPLE %s\n",measurement(m).dump().c_str());fflush(stderr);
          if(!m.valid || m.rss>limit || m.foot>limit || m.available<512ull*1024*1024){fprintf(stderr,"FIXTURE_STOPPED memory headroom\n");std::_Exit(75);}
          for(int i=0;i<40 && !done;i++)std::this_thread::sleep_for(std::chrono::milliseconds(50));}});
      fd_owner source;source.open_file(argv[2],O_RDONLY);
      check(uint64_t(source.baseline.st_size)==14439363584ull,"pinned verified artifact size mismatch");
      header_reader buffered_header{&source};original=gguf_init_from_callback(header_read,&buffered_header,chunk,uint64_t(source.baseline.st_size),{true,&metadata});
      check(original && metadata,"metadata-only original parse");const uint64_t metadata_read_bytes=source_read;
      auto arch=gguf_find_key(original,"general.architecture"),count=gguf_find_key(original,"gemma4.block_count");
      check(arch>=0 && gguf_get_kv_type(original,arch)==GGUF_TYPE_STRING && std::string(gguf_get_val_str(original,arch))=="gemma4" &&
            count>=0 && gguf_get_kv_type(original,count)==GGUF_TYPE_UINT32 && gguf_get_val_u32(original,count)==30,"actual source Gemma30-layer metadata");
      auto kv=gguf_find_key(original,"gemma4.attention.head_count_kv"),swa=gguf_find_key(original,"gemma4.attention.sliding_window_pattern");
      check(kv>=0 && swa>=0 && gguf_get_arr_type(original,kv)==GGUF_TYPE_INT32 && gguf_get_arr_type(original,swa)==GGUF_TYPE_BOOL &&
            gguf_get_arr_n(original,kv)==30 && gguf_get_arr_n(original,swa)==30,"expected full per-layer metadata arrays");
      const auto * heads=static_cast<const int32_t*>(gguf_get_arr_data(original,kv));const auto * sliding=static_cast<const int8_t*>(gguf_get_arr_data(original,swa));
      check(heads[0]==8 && heads[1]==8 && sliding[0]==1 && sliding[1]==1,"first two original layers must be SWA");
      for(int64_t i=0;i<gguf_get_n_kv(original);i++){
        const std::string key=gguf_get_key(original,i);if(key.rfind("gemma4.",0)==0 && gguf_get_kv_type(original,i)==GGUF_TYPE_ARRAY)
          check((key=="gemma4.attention.head_count_kv" || key=="gemma4.attention.sliding_window_pattern"),"unaccounted architecture array requires explicit fixture design");
      }
      target=gguf_init_empty();check(target!=nullptr,"new fixture metadata");gguf_set_kv(target,original);
      gguf_set_val_u32(target,"gemma4.block_count",2);
      gguf_set_val_str(target,"general.name","COMPUTATIONAL QA ONLY: Gemma4 original layers 0 and 1, no language-quality claim");
      gguf_set_val_str(target,"free_local_agent.fixture.source_sha256","3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d");
      gguf_set_val_str(target,"free_local_agent.fixture.scope","CPU numerical parity only; original layers 0/1; not a pretrained language model");
      gguf_set_arr_data(target,"gemma4.attention.head_count_kv",GGUF_TYPE_INT32,heads,2);
      gguf_set_arr_data(target,"gemma4.attention.sliding_window_pattern",GGUF_TYPE_BOOL,sliding,2);
      json tensors=json::array();uint64_t raw=0,routed=0;int groups[2]={0,0};
      for(int64_t i=0;i<gguf_get_n_tensors(original);i++){
        const std::string name=gguf_get_tensor_name(original,i);
        const bool keep=name=="token_embd.weight" || name=="output_norm.weight" || name.rfind("blk.0.",0)==0 || name.rfind("blk.1.",0)==0;
        if(!keep)continue;auto * tensor=ggml_get_tensor(metadata,name.c_str());check(tensor && tensor->data==nullptr,"metadata must never allocate original tensor payload");
        gguf_add_tensor(target,tensor);const auto n=ggml_nbytes(tensor);raw+=n;
        if(name.find("_exps.weight")!=std::string::npos){routed+=n;groups[name.rfind("blk.0.",0)==0?0:1]++;}
        tensors.push_back({{"name",name},{"type",ggml_type_name(tensor->type)},{"dimensions",{tensor->ne[0],tensor->ne[1],tensor->ne[2],tensor->ne[3]}},
          {"sizeBytes",n},{"sourceOffset",gguf_get_data_offset(original)+gguf_get_tensor_offset(original,i)}});
      }
      check(raw==1524058120ull && routed==856424448ull && groups[0]==2 && groups[1]==2,"exact private two-layer tensor inventory mismatch");
      const auto meta_bytes=gguf_get_meta_size(target);check(meta_bytes<=metadata_limit,"bounded private metadata serialization");
      std::vector<uint8_t> meta(meta_bytes),buffer(chunk);gguf_get_meta_data(target,meta.data());
      uint64_t total=meta_bytes;for(auto & t:tensors){const auto id=gguf_find_tensor(target,t["name"].get<std::string>().c_str());check(id>=0,"target tensor lookup");
        t["destinationOffset"]=meta_bytes+gguf_get_tensor_offset(target,id);total=std::max<uint64_t>(total,t["destinationOffset"].get<uint64_t>()+t["sizeBytes"].get<uint64_t>());}
      check(access(out.c_str(),F_OK)!=0 && errno==ENOENT && access(report.c_str(),F_OK)!=0 && errno==ENOENT,"private destination/report must be new");
      fd_owner destination;destination.open_file(partial,O_RDWR|O_CREAT|O_EXCL);owned_partial=true;
      check(ftruncate(destination.fd,total)==0,"private bounded destination size");destination.write_at(meta.data(),meta.size(),0);
      for(auto & t:tensors){CC_SHA256_CTX sha;check(CC_SHA256_Init(&sha)==1,"per-tensor SHA start");
        const uint64_t bytes=t["sizeBytes"],s=t["sourceOffset"],d=t["destinationOffset"];
        for(uint64_t at=0;at<bytes;){const auto n=std::min<uint64_t>(chunk,bytes-at);source.read_at(buffer.data(),n,s+at,true);
          check(CC_SHA256_Update(&sha,buffer.data(),CC_LONG(n))==1,"per-tensor SHA update");destination.write_at(buffer.data(),n,d+at);at+=n;}
        t["sourceCopiedSha256"]=finish_sha(sha);t["destinationVerifiedSha256"]=digest_range(destination,d,bytes,buffer,false);
        check(t["sourceCopiedSha256"]==t["destinationVerifiedSha256"],"copied tensor bytes must match uncached destination readback");
      }
      source.unchanged();check(fsync(destination.fd)==0,"private fixture fsync");
      const auto fixture_sha=digest_range(destination,0,total,buffer,false);headroom(measure());live();
      json result={{"schemaVersion",1},{"scope","Private computational fixture only. Original quantized bytes for layers 0/1. Not language/model quality evidence."},
        {"nativePatchSha256",FIXTURE_PATCH_SHA256},{"sourceVerifiedSha256","3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d"},
        {"sourceDigestProvenance","Caller complete artifact verification required before this developer tool; current file fingerprint checked before/through/after bounded uncached selected-tensor reads. Original full-file hash is not repeated inside this tool."},
        {"sourceFingerprint",fingerprint(source.baseline)},{"sourceFingerprintUnchanged",true},{"fixturePath",out},{"fixtureSha256",fixture_sha},{"fixtureSizeBytes",total},
        {"fixtureMetadataBytes",meta_bytes},{"sourceMetadataBytesRead",metadata_read_bytes},{"rawTensorBytes",raw},{"routedTensorBytes",routed},
        {"sourceBytesRead",source_read.load()},{"destinationBytesRead",destination_read.load()},{"destinationBytesWritten",destination_written.load()},
        {"sourceReadMode","read-only local APFS F_NOCACHE/F_RDAHEAD=0 no mmap"},{"copyBufferBytes",chunk},{"residentLimitBytes",limit},
        {"selectedLayers",{0,1}},{"metadataChanges",{{"blockCount",2},{"headCountKv",{8,8}},{"slidingWindowPattern",{true,true}}}},
        {"excludedGlobalTensor","rope_freqs.weight: unused by the retained two SWA layers"},{"inferenceExecuted",false},{"nativeBundledResourcesChanged",false},
        {"initialMeasurement",measurement(initial)},{"finalMeasurement",measurement(measure())},{"elapsedSeconds",std::chrono::duration<double>(std::chrono::steady_clock::now()-begun).count()},
        {"tensors",tensors}};
      check(rename(partial.c_str(),out.c_str())==0,"publish private fully verified fixture");owned_partial=false;
      const int report_fd=open(report.c_str(),O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC|O_NOFOLLOW,0600);check(report_fd>=0,"new private report");
      const auto text=result.dump(2)+"\n";size_t wrote=0;while(wrote<text.size()){auto n=write(report_fd,text.data()+wrote,text.size()-wrote);if(n<0 && errno==EINTR)continue;check(n>0,"complete private report write");wrote+=n;}fsync(report_fd);close(report_fd);
      printf("FIXTURE_CREATED {\"sizeBytes\":%llu,\"sha256\":\"%s\",\"tensors\":%zu,\"inferenceExecuted\":false}\n",total,fixture_sha.c_str(),tensors.size());
      gguf_free(target);target=nullptr;gguf_free(original);original=nullptr;ggml_free(metadata);metadata=nullptr;
      done=true;watchdog.join();ggml_ssd_finish();return 0;
    }catch(const std::exception & e){fprintf(stderr,"FIXTURE_ERROR %s\n",e.what());done=true;if(watchdog.joinable())watchdog.join();
      if(target)gguf_free(target);if(original)gguf_free(original);if(metadata)ggml_free(metadata);if(owned_partial)unlink(partial.c_str());ggml_ssd_finish();return 1;}
}
