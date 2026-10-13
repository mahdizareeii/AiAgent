// Read-only bounded expert-matmul parity, not whole-model inference or quality.
#include "llama-moe-stream.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "ggml-ssd-policy.h"
#include "gguf.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <map>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>
#ifndef SSD_PARITY_PATCH_SHA256
#error "Bind this test to the inventoried native worker patch"
#endif
static int checks=0;
static void check(bool pass,const char * message) {
    if(!pass)throw std::runtime_error(message);checks++;
}
struct context_owner {
    ggml_context * p;
    explicit context_owner(size_t bytes,bool no_alloc):p(ggml_init({bytes,nullptr,no_alloc})) {
        check(p!=nullptr,"ggml context allocation");
    }
    ~context_owner(){ggml_free(p);}
};
struct buffer_owner {
    ggml_backend_buffer_t p=nullptr;
    ~buffer_owner(){if(p)ggml_backend_buffer_free(p);}
};
struct fd_owner {
    int p=-1;struct stat revision{};
    explicit fd_owner(const char * path) {
        p=open(path,O_RDONLY|O_NOFOLLOW);check(p>=0,"open read-only model descriptor");
        struct statfs fs{};
        check(fstat(p,&revision)==0 && S_ISREG(revision.st_mode),"regular model file");
        check(fstatfs(p,&fs)==0 && strcmp(fs.f_fstypename,"apfs")==0 && (fs.f_flags&MNT_LOCAL),"local APFS file");
        check(fcntl(p,F_NOCACHE,1)==0 && fcntl(p,F_RDAHEAD,0)==0,"uncached bounded reference reads");
    }
    ~fd_owner(){if(p>=0)close(p);}
    void unchanged()const {
        struct stat now{};
        check(fstat(p,&now)==0 && now.st_dev==revision.st_dev && now.st_ino==revision.st_ino &&
              now.st_size==revision.st_size && now.st_mtimespec.tv_sec==revision.st_mtimespec.tv_sec &&
              now.st_mtimespec.tv_nsec==revision.st_mtimespec.tv_nsec,"model unchanged during fixture");
    }
    void read(void * out,size_t bytes,uint64_t offset)const {
        check(offset<=uint64_t(revision.st_size) && bytes<=uint64_t(revision.st_size)-offset,"bounded tensor file range");
        auto * dest=static_cast<uint8_t*>(out);unchanged();
        while(bytes) {
            if(ggml_ssd_stopped())throw std::runtime_error("fixture cancelled or expired");
            const ssize_t got=pread(p,dest,std::min<size_t>(bytes,1024*1024),off_t(offset));
            if(got<0 && errno==EINTR)continue;
            check(got>0,"complete bounded reference pread");
            dest+=got;bytes-=got;offset+=got;
        }
        unchanged();
    }
};
struct weight {
    std::string name;
    ggml_tensor * meta=nullptr,*reference=nullptr,*scale=nullptr;
    uint64_t offset=0,scale_offset=0;
};
static std::vector<float> matrix(ggml_backend_t cpu,ggml_tensor * weights,ggml_tensor * scale,
                                 const std::vector<int32_t> & original,const std::vector<int32_t> & slots,
                                 int tokens,int seed,int input_experts) {
    ggml_ssd_scope category(GGML_SSD_SCRATCH);
    context_owner arena(32*1024*1024,false);
    auto * ids=ggml_new_tensor_2d(arena.p,GGML_TYPE_I32,8,tokens);
    auto * scale_ids=ggml_dup_tensor(arena.p,ids);
    memcpy(ids->data,slots.data(),slots.size()*sizeof(int32_t));
    memcpy(scale_ids->data,original.data(),original.size()*sizeof(int32_t));
    auto * input=ggml_new_tensor_3d(arena.p,GGML_TYPE_F32,weights->ne[0],input_experts,tokens);
    for(int64_t i=0;i<ggml_nelements(input);i++)
        static_cast<float*>(input->data)[i]=float((i*13+seed*7)%29-14)/37.0f;
    auto * out=ggml_mul_mat_id(arena.p,weights,input,ids);
    if(scale) {
        // Match pinned build_lora_mm_id: scales retain original expert IDs.
        auto * gathered=ggml_reshape_3d(arena.p,scale,1,scale->ne[0],1);
        gathered=ggml_repeat_4d(arena.p,gathered,1,scale->ne[0],tokens,1);
        gathered=ggml_get_rows(arena.p,gathered,scale_ids);
        out=ggml_mul(arena.p,out,gathered);
    }
    auto * graph=ggml_new_graph(arena.p);ggml_build_forward_expand(graph,out);
    check(ggml_backend_graph_compute(cpu,graph)==GGML_STATUS_SUCCESS,"ordinary/streamed quantized CPU graph computes");
    std::vector<float> result(ggml_nelements(out));
    memcpy(result.data(),out->data,result.size()*sizeof(float));return result;
}
static std::vector<int32_t> routed(int tokens,bool partial=false) {
    std::vector<int32_t> ids(8*tokens);
    for(size_t i=0;i<ids.size();i++)ids[i]=int32_t((i*17+3)%128);
    if(partial)for(int i=0;i<7;i++)ids[32+i]=ids[i];
    return ids;
}
static void raw_cache(llama_moe_stream_layer * sl,const std::vector<weight> & weights,
                      const std::vector<int32_t> & original,const int32_t * slots,const float * mask=nullptr) {
    for(size_t i=0;i<original.size();i++) {
        if(mask && mask[i]==0)continue;
        check(slots[i]>=0 && uint32_t(slots[i])<24,"bounded remapped slot");
        for(size_t w=0;w<weights.size();w++) {
            const auto & cached=sl->weights[w];
            check(memcmp(static_cast<uint8_t*>(cached.cache->data)+slots[i]*cached.nb_expert,
                         static_cast<uint8_t*>(weights[w].reference->data)+original[i]*cached.nb_expert,
                         cached.nb_expert)==0,"actual quantized expert slab bytes preserved");
        }
    }
}
static void run_case(ggml_backend_t cpu,llama_moe_stream & mgr,const std::vector<weight> & weights,
                     const std::vector<int32_t> & original,const char * name,bool waves) {
    const int tokens=int(original.size()/8);auto * sl=mgr.layer(0);
    context_owner control(1024*1024,false);
    auto * ids=ggml_new_tensor_2d(control.p,GGML_TYPE_I32,8,tokens);
    auto * remapped=ggml_dup_tensor(control.p,ids);remapped->src[0]=ids;
    auto * mask=ggml_new_tensor_2d(control.p,GGML_TYPE_F32,8,tokens);mask->src[0]=ids;
    memcpy(ids->data,original.data(),original.size()*sizeof(int32_t));
    size_t evidence_size=0;for(const auto & w:weights)evidence_size+=w.reference->ne[1]*original.size()*sizeof(float);
    ggml_ssd_bytes evidence_budget(evidence_size*3,GGML_SSD_CONTEXT);
    std::vector<std::vector<float>> baseline,accumulated;
    for(size_t w=0;w<weights.size();w++) {
        baseline.push_back(matrix(cpu,weights[w].reference,weights[w].scale,original,original,tokens,int(w),weights[w].name.find(".ffn_down_exps.")!=std::string::npos?8:1));
        accumulated.emplace_back(baseline.back().size(),0.0f);
    }
    const std::set<int32_t> unique(original.begin(),original.end());
    const int passes=waves ? int((unique.size()+7)/8) : 1;
    std::vector<float> contribution(original.size(),0.0f);
    for(int wave=0;wave<passes;wave++) {
        if(waves) {
            auto * ud=sl->wave_userdata(wave,8);
            llama_moe_stream_wave_ids(remapped,0,1,ud);
            llama_moe_stream_wave_mask(mask,0,1,ud);
        } else {
            llama_moe_stream_remap(remapped,ids,0,1,sl);
            std::fill_n(static_cast<float*>(mask->data),original.size(),1.0f);
        }
        std::vector<int32_t> slots(original.size());memcpy(slots.data(),remapped->data,slots.size()*sizeof(int32_t));
        raw_cache(sl,weights,original,slots.data(),static_cast<float*>(mask->data));
        for(size_t w=0;w<weights.size();w++) {
            auto actual=matrix(cpu,sl->weights[w].cache,weights[w].scale,original,slots,tokens,int(w),weights[w].name.find(".ffn_down_exps.")!=std::string::npos?8:1);
            const size_t columns=weights[w].reference->ne[1];
            for(size_t i=0;i<actual.size();i++)accumulated[w][i]+=actual[i]*static_cast<float*>(mask->data)[i/columns];
        }
        for(size_t i=0;i<original.size();i++)contribution[i]+=static_cast<float*>(mask->data)[i];
    }
    double max_absolute=0,max_relative=0;
    for(size_t w=0;w<weights.size();w++)for(size_t i=0;i<baseline[w].size();i++) {
        const double wanted=baseline[w][i],got=accumulated[w][i],delta=fabs(got-wanted);
        check(std::isfinite(wanted) && std::isfinite(got),"finite real quantized expert results");
        check(delta<=1e-5+1e-5*fabs(wanted),"quantized ordinary/streamed expert numerical parity");
        max_absolute=std::max(max_absolute,delta);max_relative=std::max(max_relative,delta/std::max(1e-12,fabs(wanted)));
    }
    for(float n:contribution)check(n==1.0f,"each selected pair contributes exactly once");
    check(sl->expert_slot.size()<=24 && mgr.workers.size()==2,"bounded cache and two workers");
    if(waves)check(sl->plan_n_waves==uint32_t(passes),"actual full/partial wave count");
    printf("SSD_PARITY_CASE {\"name\":\"%s\",\"tokens\":%d,\"uniqueExperts\":%zu,\"waves\":%d,\"maxAbsoluteDifference\":%.9g,\"maxRelativeDifference\":%.9g,\"passed\":true}\n",
           name,tokens,unique.size(),passes,max_absolute,max_relative);fflush(stdout);
}
int main(int argc,char ** argv) {
    gguf_context * header=nullptr;ggml_context * metadata=nullptr;ggml_backend_t cpu=nullptr;
    const auto started=std::chrono::steady_clock::now();
    try {
        if(argc!=7 || std::string(argv[1])!="--model" || std::string(argv[3])!="--verified-model-sha256" ||
           std::string(argv[5])!="--expected-patch-sha256")throw std::invalid_argument("strict model/digest/patch arguments required");
        const std::string digest=argv[4];
        check(digest.size()==64 && std::all_of(digest.begin(),digest.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');}),"caller verified digest format");
        check(std::string(argv[6])==SSD_PARITY_PATCH_SHA256,"test compiled against inventoried patch");
        // Both budgets are below 1GiB. This process never creates an LLM context.
        ggml_ssd_start(900ull*1024*1024,960ull*1024*1024,300000);
        ggml_backend_load_all();cpu=ggml_backend_cpu_init();check(cpu!=nullptr,"CPU backend");
        ggml_backend_cpu_set_n_threads(cpu,4);
        header=gguf_init_from_file(argv[2],{true,&metadata});check(header && metadata,"GGUF metadata only");
        auto architecture=gguf_find_key(header,"general.architecture");
        check(architecture>=0 && std::string(gguf_get_val_str(header,architecture))=="gemma4","actual Gemma4 artifact");
        std::map<int,std::vector<weight>> groups;
        for(int64_t i=0;i<gguf_get_n_tensors(header);i++) {
            const std::string name=gguf_get_tensor_name(header,i);int layer=-1;char role[32]{};int used=0;
            if(sscanf(name.c_str(),"blk.%d.ffn_%31[^.].weight%n",&layer,role,&used)!=2 || size_t(used)!=name.size())continue;
            const std::string r=role;if(r!="gate_exps" && r!="up_exps" && r!="down_exps" && r!="gate_up_exps")continue;
            auto * t=ggml_get_tensor(metadata,name.c_str());
            check(layer>=0 && layer<256 && t && t->ne[2]==128 && t->ne[3]==1 &&
                  t->ne[0]>0 && t->ne[0]<=32768 && t->ne[1]>0 && t->ne[1]<=32768 && ggml_is_quantized(t->type),"bounded real quantized routed layout");
            groups[layer].push_back({name,t,nullptr,nullptr,gguf_get_data_offset(header)+gguf_get_tensor_offset(header,i),0});
        }
        check(groups.size()==30,"all30 Gemma routed metadata groups surveyed");
        std::map<std::string,std::vector<int>> layouts;
        for(auto & entry:groups) {
            auto & weights=entry.second;
            std::sort(weights.begin(),weights.end(),[](auto & a,auto & b){return a.name<b.name;});
            bool down=false,up=false,gate=false,fused=false;std::string signature;
            for(auto & w:weights) {
                down|=w.name.find(".ffn_down_exps.")!=std::string::npos;
                up|=w.name.find(".ffn_up_exps.")!=std::string::npos;
                gate|=w.name.find(".ffn_gate_exps.")!=std::string::npos;
                fused|=w.name.find(".ffn_gate_up_exps.")!=std::string::npos;
                const auto suffix=w.name.substr(w.name.find(".ffn_"));
                signature+=suffix+":"+ggml_type_name(w.meta->type)+":"+std::to_string(w.meta->ne[0])+":"+std::to_string(w.meta->ne[1]);
                const auto scale_name=w.name.substr(0,w.name.size()-6)+"scale";
                const auto sid=gguf_find_tensor(header,scale_name.c_str());
                // Pinned fused gate_up path does not instantiate a fused scale.
                if(sid>=0 && w.name.find(".ffn_gate_up_exps.")==std::string::npos) {
                    auto * scale=ggml_get_tensor(metadata,scale_name.c_str());
                    check(scale && scale->ne[0]==128 && ggml_nelements(scale)==128 && !ggml_is_quantized(scale->type),"original-ID scalar expert scale layout");
                    w.scale=scale;w.scale_offset=gguf_get_data_offset(header)+gguf_get_tensor_offset(header,sid);
                    signature+=":scale:"+std::string(ggml_type_name(scale->type));
                }
                signature+=";";
            }
            check(down && ((fused && !up && !gate && weights.size()==2) || (!fused && up && gate && weights.size()==3)),"complete fused/separate expert group");
            layouts[signature].push_back(entry.first);
        }
        std::set<int> representatives;
        for(const auto & layout:layouts){representatives.insert(layout.second.front());representatives.insert(layout.second.back());}
        printf("SSD_PARITY_METADATA {\"groupsSurveyed\":30,\"distinctLayouts\":%zu,\"representativeGroups\":%zu,\"scope\":\"quantized expert matmuls and original-ID scales only\"}\n",layouts.size(),representatives.size());fflush(stdout);
        fd_owner file(argv[2]);
        for(int layer:representatives) {
            const auto elapsed=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count();
            check(elapsed<300000 && ggml_ssd_deadline(300000-elapsed),"shared five-minute fixture deadline");
            {
                context_owner weights_context(1024*1024,true);buffer_owner reference_buffer;
                auto weights=groups.at(layer);uint64_t per_expert=0;
                llama_moe_stream mgr(1,24,2,false);
                for(auto & w:weights) {
                    w.reference=ggml_new_tensor_3d(weights_context.p,w.meta->type,w.meta->ne[0],w.meta->ne[1],128);
                    if(w.scale)w.scale=ggml_dup_tensor(weights_context.p,w.scale);
                    mgr.create_cache_tensor(0,ggml_backend_cpu_buffer_type(),w.meta,0,w.offset);
                    per_expert+=ggml_nbytes(w.meta)/128;
                }
                check(ggml_ssd_slots(128,8,per_expert,24*per_expert,24)==24,"production3xtopK cache floor");
                ggml_ssd_cache_budget(24*per_expert);
                {ggml_ssd_scope kind(GGML_SSD_DENSE);reference_buffer.p=ggml_backend_alloc_ctx_tensors_from_buft(weights_context.p,ggml_backend_cpu_buffer_type());}
                check(reference_buffer.p!=nullptr,"bounded ordinary CPU expert reference allocation");
                for(auto & w:weights) {
                    file.read(w.reference->data,ggml_nbytes(w.reference),w.offset);
                    if(w.scale)file.read(w.scale->data,ggml_nbytes(w.scale),w.scale_offset);
                    printf("SSD_PARITY_TENSOR {\"name\":\"%s\",\"quantization\":\"%s\",\"inputWidth\":%lld,\"outputWidth\":%lld,\"experts\":128,\"actualScaleApplied\":%s}\n",w.name.c_str(),ggml_type_name(w.meta->type),w.meta->ne[0],w.meta->ne[1],w.scale?"true":"false");
                }
                mgr.alloc_bufs(false);mgr.open_files({argv[2]});
                ggml_ssd_groups(1,1,24);ggml_ssd_stage("parity");
                run_case(cpu,mgr,weights,routed(1),"cold-decode",false);
                auto misses=mgr.stats.n_miss;
                run_case(cpu,mgr,weights,routed(1),"warm-decode",false);
                check(mgr.stats.n_miss==misses,"warm actual-weight hit does not reread");
                context_owner eviction(1024*1024,false);
                auto * ids=ggml_new_tensor_2d(eviction.p,GGML_TYPE_I32,8,1);auto * slots=ggml_dup_tensor(eviction.p,ids);
                for(int base=0;base<128;base+=8) {
                    std::vector<int32_t> original(8);for(int j=0;j<8;j++)original[j]=base+j;
                    memcpy(ids->data,original.data(),8*sizeof(int32_t));llama_moe_stream_remap(slots,ids,0,1,mgr.layer(0));
                    raw_cache(mgr.layer(0),weights,original,static_cast<int32_t*>(slots->data));
                }
                std::vector<int32_t> evicted;
                for(int expert=0;expert<128 && evicted.size()<8;expert++)if(!mgr.layer(0)->expert_slot.count(expert))evicted.push_back(expert);
                check(evicted.size()==8 && mgr.stats.n_miss>24,"actual expert eviction occurred");
                run_case(cpu,mgr,weights,evicted,"eviction-reload",false);
                run_case(cpu,mgr,weights,routed(4),"four-full-waves",true);
                run_case(cpu,mgr,weights,routed(5,true),"partial-final-wave",true);
                file.unchanged();
                // A tiny fixture may finish within one watchdog interval.
                // Retain its populated buffers for one fresh resident sample.
                std::this_thread::sleep_for(std::chrono::milliseconds(2200));
                printf("SSD_PARITY_GROUP {\"layer\":%d,\"ordinaryExpertBytes\":%zu,\"cacheBytes\":%zu,\"hits\":%lld,\"cacheMisses\":%lld,\"residentMemorySample\":%s,\"passed\":true}\n",layer,ggml_backend_buffer_get_size(reference_buffer.p),mgr.size_bufs(),mgr.stats.n_hit,mgr.stats.n_miss,ggml_ssd_snapshot());fflush(stdout);
            }
        }
        ggml_backend_free(cpu);cpu=nullptr;ggml_free(metadata);metadata=nullptr;gguf_free(header);header=nullptr;
        printf("SSD_PARITY_FINAL {\"passed\":true,\"checks\":%d,\"verifiedModelSha256FromCaller\":\"%s\",\"patchSha256\":\"%s\",\"allocationBudgetBytes\":943718400,\"residentLimitBytes\":1006632960,\"llmInferencePerformed\":false,\"scope\":\"representative actual quantized routed layouts, raw bytes, production-shaped CPU expert matmuls (broadcast up, per-expert down), original-ID scales, eviction and waves; not full model/router/quality or Metal numerical parity\"}\n",checks,digest.c_str(),SSD_PARITY_PATCH_SHA256);
        ggml_ssd_finish();return 0;
    } catch(const std::exception & error) {
        fprintf(stderr,"SSD_PARITY_ERROR %s\n",error.what());
        if(cpu)ggml_backend_free(cpu);if(metadata)ggml_free(metadata);if(header)gguf_free(header);
        ggml_ssd_finish();return 1;
    }
}
