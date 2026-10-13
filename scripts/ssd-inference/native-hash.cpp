// Per-descriptor uncached GGUF integrity verification; no model initialization.
#include <CommonCrypto/CommonDigest.h>
#include <libproc.h>
#include <mach/mach.h>
#include <sys/mount.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <fcntl.h>
#include <unistd.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#ifndef SSD_PATCH_SHA256
#error "Hash helper requires the inventoried worker patch identity"
#endif
#ifndef SSD_HASH_SOURCE_SHA256
#error "Hash helper requires its inventoried source identity"
#endif
static volatile sig_atomic_t cancelled=0;
static void signal_cancel(int){cancelled=1;}
struct hash_error : std::runtime_error {
    const char * code;
    hash_error(const char * c,const char * message):std::runtime_error(message),code(c){}
};
static void error_json(const char * code,const char * message) {
    // Messages are fixed strings and never include paths, keys or user content.
    fprintf(stderr,"SSD_HASH_ERROR {\"code\":\"%s\",\"message\":\"%s\"}\n",code,message);fflush(stderr);
}
static uint64_t number(const std::string & s) {
    if(s.empty() || !std::all_of(s.begin(),s.end(),[](char c){return c>='0'&&c<='9';}))throw std::invalid_argument("strict decimal integer required");
    size_t used=0;auto n=std::stoull(s,&used);if(used!=s.size())throw std::invalid_argument("invalid integer");return n;
}
struct measurement { uint64_t rss=0,footprint=0,available=0;int pressure=0;bool valid=false; };
static measurement measure() {
    measurement m; rusage_info_v4 usage{};
    vm_statistics64_data_t vm{};mach_msg_type_number_t count=HOST_VM_INFO64_COUNT;vm_size_t page=0;
    const mach_port_t host=mach_host_self();
    const bool ok=proc_pid_rusage(getpid(),RUSAGE_INFO_V4,(rusage_info_t*)&usage)==0 &&
        host_page_size(host,&page)==KERN_SUCCESS &&
        host_statistics64(host,HOST_VM_INFO64,(host_info64_t)&vm,&count)==KERN_SUCCESS;
    mach_port_deallocate(mach_task_self(),host);
    if(ok) {
        m.rss=usage.ri_resident_size;m.footprint=usage.ri_phys_footprint;
        m.available=(uint64_t(vm.free_count)+vm.inactive_count+vm.speculative_count)*page;
        m.valid=m.rss>0 && m.footprint>0 && page>0;
    }
    size_t size=sizeof(m.pressure);
    if(sysctlbyname("kern.memorystatus_vm_pressure_level",&m.pressure,&size,nullptr,0)!=0)m.pressure=0;
    return m;
}
static const char * pressure_name(int pressure) {
    return pressure==1?"normal":pressure==2?"warning":pressure>=4?"critical":"unknown";
}
struct file_owner {
    int fd=-1;struct stat original{};
    ~file_owner(){if(fd>=0)close(fd);}
    void unchanged()const {
        struct stat now{};
        if(fstat(fd,&now)!=0 || now.st_dev!=original.st_dev || now.st_ino!=original.st_ino ||
           now.st_size!=original.st_size || now.st_mtimespec.tv_sec!=original.st_mtimespec.tv_sec ||
           now.st_mtimespec.tv_nsec!=original.st_mtimespec.tv_nsec || now.st_ctimespec.tv_sec!=original.st_ctimespec.tv_sec ||
           now.st_ctimespec.tv_nsec!=original.st_ctimespec.tv_nsec)
            throw std::runtime_error("input fingerprint changed during verification");
    }
};
static void progress(uint64_t read,uint64_t size,const measurement & m) {
    fprintf(stderr,"SSD_HASH_PROGRESS {\"bytesRead\":%llu,\"sizeBytes\":%llu,\"rssBytes\":%llu,\"physicalFootprintBytes\":%llu,\"availableRamBytes\":%llu,\"memoryPressure\":\"%s\",\"ioMode\":\"darwin-nocache\"}\n",
        read,size,m.rss,m.footprint,m.available,pressure_name(m.pressure));fflush(stderr);
}
int main(int argc,char ** argv) {
    std::atomic<bool> done{false};std::atomic<uint64_t> bytes_read{0};std::thread watchdog;
    try {
        std::map<std::string,std::string> opts;
        const char * allowed[]={"--file","--deadline-ms","--resident-limit-bytes"};
        for(int i=1;i<argc;i+=2) {
            if(i+1>=argc || std::find(std::begin(allowed),std::end(allowed),std::string(argv[i]))==std::end(allowed) ||
               !opts.emplace(argv[i],argv[i+1]).second)throw std::invalid_argument("unknown, duplicate or missing hash argument");
        }
        for(auto key:allowed)if(!opts.count(key))throw std::invalid_argument("missing required hash argument");
        const uint64_t deadline_ms=number(opts.at("--deadline-ms")),limit=number(opts.at("--resident-limit-bytes"));
        if(!deadline_ms || deadline_ms>30ull*60*1000 || limit<32ull*1024*1024 || limit>256ull*1024*1024)
            throw std::invalid_argument("hash deadline/measurement limit exceeds bounded profile");
        file_owner file;
        file.fd=open(opts.at("--file").c_str(),O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
        if(file.fd<0)throw std::runtime_error("cannot open read-only regular input");
        struct statfs fs{};
        if(fstat(file.fd,&file.original)!=0 || !S_ISREG(file.original.st_mode) || file.original.st_size<0)
            throw std::runtime_error("integrity input must be a valid regular file");
        if(fstatfs(file.fd,&fs)!=0)throw std::runtime_error("filesystem validation failed");
        if(strcmp(fs.f_fstypename,"apfs")!=0 || !(fs.f_flags&MNT_LOCAL))
            throw hash_error("SSD_HASH_FILESYSTEM_UNSUPPORTED","integrity verification requires a local APFS file");
        constexpr uint64_t safe=9007199254740991ull;
        if(uint64_t(file.original.st_dev)>safe || uint64_t(file.original.st_ino)>safe || uint64_t(file.original.st_size)>safe)
            throw std::runtime_error("input fingerprint exceeds exact IPC integer range");
        if(fcntl(file.fd,F_NOCACHE,1)!=0 || fcntl(file.fd,F_RDAHEAD,0)!=0) {
            if(errno==EINVAL || errno==ENOTSUP || errno==ENOTTY)
                throw hash_error("SSD_HASH_FILESYSTEM_UNSUPPORTED","descriptor does not support required uncached I/O");
            throw std::runtime_error("per-descriptor uncached I/O could not be enabled");
        }
        const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(deadline_ms);
        signal(SIGTERM,signal_cancel);signal(SIGINT,signal_cancel);
        auto initial=measure();
        if(!initial.valid || initial.rss>limit || initial.footprint>limit || initial.available<512ull*1024*1024 || initial.pressure>=4)
            throw std::runtime_error("insufficient monitored integrity-process headroom");
        progress(0,file.original.st_size,initial);
        watchdog=std::thread([&]{
            auto next=std::chrono::steady_clock::now()+std::chrono::seconds(2);
            while(!done) {
                const auto now=std::chrono::steady_clock::now();
                const char * error=cancelled?"cancelled":now>=deadline?"deadline":nullptr;
                if(now>=next) {
                    const auto sample=measure();next=now+std::chrono::seconds(2);
                    progress(bytes_read.load(),file.original.st_size,sample);
                    if(!sample.valid)error="native-memory-monitor-unavailable";
                    else if(sample.rss>limit || sample.footprint>limit)error="resident-memory-budget";
                    else if(sample.available<512ull*1024*1024)error="available-memory-floor";
                    else if(sample.pressure>=4)error="critical-memory-pressure";
                }
                if(error) {error_json("SSD_HASH_STOPPED",error);std::_Exit(75);}
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
            }
        });
        constexpr size_t buffer_bytes=1024*1024;
        auto buffer=std::make_unique<uint8_t[]>(buffer_bytes);
        CC_SHA256_CTX digest;
        if(CC_SHA256_Init(&digest)!=1)throw std::runtime_error("system SHA256 initialization failed");
        while(bytes_read<uint64_t(file.original.st_size)) {
            if(cancelled)throw hash_error("SSD_HASH_CANCELLED","cancelled");
            if(std::chrono::steady_clock::now()>=deadline)throw hash_error("SSD_HASH_DEADLINE","deadline");
            file.unchanged();const uint64_t at=bytes_read.load();
            const ssize_t got=pread(file.fd,buffer.get(),std::min<uint64_t>(buffer_bytes,uint64_t(file.original.st_size)-at),off_t(at));
            if(got<0 && errno==EINTR)continue;
            if(got<=0)throw std::runtime_error("incomplete integrity read");
            if(CC_SHA256_Update(&digest,buffer.get(),CC_LONG(got))!=1)throw std::runtime_error("system SHA256 update failed");
            bytes_read+=uint64_t(got);
        }
        file.unchanged();unsigned char result[CC_SHA256_DIGEST_LENGTH];
        if(CC_SHA256_Final(result,&digest)!=1)throw std::runtime_error("system SHA256 finalization failed");
        char hex[65]{};for(int i=0;i<CC_SHA256_DIGEST_LENGTH;i++)snprintf(hex+i*2,3,"%02x",result[i]);
        const auto final=measure();
        if(!final.valid || final.rss>limit || final.footprint>limit || final.available<512ull*1024*1024 || final.pressure>=4)
            throw std::runtime_error("integrity-process final headroom validation failed");
        if(cancelled)throw hash_error("SSD_HASH_CANCELLED","cancelled");
        if(std::chrono::steady_clock::now()>=deadline)throw hash_error("SSD_HASH_DEADLINE","deadline");
        printf("SSD_HASH {\"schemaVersion\":1,\"helperIdentity\":\"free-local-agent-ssd-hash-v1\",\"baseCommit\":\"d81235049384534c167caea52b85a694f6103d14\",\"patchSha256\":\"%s\",\"helperSourceSha256\":\"%s\",\"sha256\":\"%s\",\"sizeBytes\":%llu,\"bytesRead\":%llu,\"ioMode\":\"darwin-nocache\",\"bufferBytes\":1048576,\"fingerprint\":{\"device\":%llu,\"inode\":%llu,\"sizeBytes\":%llu,\"mtimeSeconds\":%lld,\"mtimeNanoseconds\":%ld,\"ctimeSeconds\":%lld,\"ctimeNanoseconds\":%ld},\"rssBytes\":%llu,\"physicalFootprintBytes\":%llu,\"availableRamBytes\":%llu,\"memoryPressure\":\"%s\"}\n",
          SSD_PATCH_SHA256,SSD_HASH_SOURCE_SHA256,hex,uint64_t(file.original.st_size),bytes_read.load(),uint64_t(file.original.st_dev),uint64_t(file.original.st_ino),uint64_t(file.original.st_size),int64_t(file.original.st_mtimespec.tv_sec),file.original.st_mtimespec.tv_nsec,int64_t(file.original.st_ctimespec.tv_sec),file.original.st_ctimespec.tv_nsec,final.rss,final.footprint,final.available,pressure_name(final.pressure));fflush(stdout);
        done=true;watchdog.join();return 0;
    } catch(const std::exception & e) {
        const auto * typed=dynamic_cast<const hash_error*>(&e);
        error_json(typed?typed->code:"SSD_HASH_FAILED",e.what());done=true;if(watchdog.joinable())watchdog.join();
        return cancelled || (typed && (strcmp(typed->code,"SSD_HASH_CANCELLED")==0 || strcmp(typed->code,"SSD_HASH_DEADLINE")==0))?75:1;
    }
}
