#include "llama.h"
#include "llama-ext.h"
#include "llama-model.h"
#include "llama-context.h"
#include "llama-moe-stream.h"
#include "llama-memory-hybrid.h"
#include "llama-memory-hybrid-iswa.h"
#include "ggml-cpu.h"
#include "ggml-ssd-policy.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <stdexcept>
#include <string>
#include <thread>
#include <libproc.h>
#include <sys/resource.h>
#include <unistd.h>
#ifndef SSD_PATCH_SHA256
#error "Planner must be built with the audited worker patch identity"
#endif
#ifndef SSD_PLAN_SOURCE_SHA256
#error "Planner must be built with its source identity"
#endif
static volatile sig_atomic_t cancelled = 0;
static void signal_cancel(int) { cancelled=1; }
static uint64_t number(const std::string & value) {
    if(value.empty() || !std::all_of(value.begin(),value.end(),[](char c){return c>='0'&&c<='9';}))
        throw std::invalid_argument("planner integer must contain decimal digits only");
    size_t used=0;auto n=std::stoull(value,&used);if(used!=value.size())throw std::invalid_argument("invalid planner integer");return n;
}
static uint64_t aligned(uint64_t bytes,ggml_backend_buffer_type_t buft) {
    if(strncmp(ggml_backend_buft_name(buft),"MTL",3)==0) {
        if(bytes>UINT64_MAX-16383) throw std::runtime_error("planner alignment overflow");
        return (bytes+16383)&~uint64_t(16383);
    }
    return bytes;
}
static uint64_t sum_memory(llama_memory_t memory) {
    uint64_t sum=0;for(auto & item:memory->memory_breakdown())sum+=aligned(item.second,item.first);return sum;
}
int main(int argc,char ** argv) {
    llama_model * model=nullptr;llama_context * ctx=nullptr;
    std::atomic<bool> done{false};std::thread cancellation;
    try {
        std::map<std::string,std::string> options;
        const char * allowed[]={"--model","--backend","--ctx-size","--batch-size","--ubatch-size","--output-tokens",
                               "--cache-slots","--cache-bytes","--ssd-budget-bytes","--ssd-resident-limit-bytes","--deadline-ms"};
        for(int i=1;i<argc;i+=2) {
            if(i+1>=argc || std::find(std::begin(allowed),std::end(allowed),std::string(argv[i]))==std::end(allowed) ||
               !options.emplace(argv[i],argv[i+1]).second) throw std::invalid_argument("unknown, duplicate, or missing planner argument");
        }
        for(auto key:allowed) if(std::string(key)!="--deadline-ms" && !options.count(key))throw std::invalid_argument("missing required planner argument");
        const std::string backend=options.at("--backend");
        const uint64_t context=number(options.at("--ctx-size")),batch=number(options.at("--batch-size")),micro=number(options.at("--ubatch-size"));
        const uint64_t output_tokens=number(options.at("--output-tokens"));
        const uint64_t slots=number(options.at("--cache-slots")),cache_budget=number(options.at("--cache-bytes"));
        const uint64_t budget=number(options.at("--ssd-budget-bytes")),limit=number(options.at("--ssd-resident-limit-bytes"));
        const uint64_t deadline=options.count("--deadline-ms")?number(options.at("--deadline-ms")):30000;
        const bool legacy_shape=context==4096 && output_tokens==1024;
        const bool qwen_shape=context==8192 && output_tokens==2048 && backend=="cpu" && slots==30;
        if((backend!="cpu" && backend!="metal") || !(legacy_shape || qwen_shape) || batch!=64 || micro!=16 ||
           slots==0 || slots>4096 || cache_budget==0 || deadline==0 || deadline>30000)
            throw std::invalid_argument("planner accepts only legacy4K or exact QwenCPU8K/2048/30-slot shape");
        signal(SIGTERM,signal_cancel);signal(SIGINT,signal_cancel);
        ggml_ssd_start(budget,limit,deadline);
        cancellation=std::thread([&]{while(!done){if(cancelled){ggml_ssd_cancel("cancelled");return;}std::this_thread::sleep_for(std::chrono::milliseconds(50));}});
        llama_backend_init();
        auto mp=llama_model_default_params();
        mp.no_alloc=true;mp.load_mode=LLAMA_LOAD_MODE_NONE;mp.n_gpu_layers=backend=="cpu"?0:999;
        mp.use_extra_bufts=backend!="cpu";
        mp.moe_stream=true;mp.moe_stream_slots=slots;mp.moe_stream_budget=cache_budget;mp.moe_stream_io_threads=2;mp.load_mtp=false;
        ggml_backend_dev_t cpu_only[]={nullptr};if(backend=="cpu")mp.devices=cpu_only;
        mp.progress_callback=[](float,void*){return !cancelled && !ggml_ssd_stopped();};
        model=llama_model_load_from_file(options.at("--model").c_str(),mp);
        if(!model || !model->hparams.no_alloc || !model->moe_stream())throw std::runtime_error("metadata-only SSD model planning failed");
        if(qwen_shape && (model->arch_name()!="qwen3next" || model->hparams.n_layer()!=48 || model->hparams.n_expert!=512 || model->hparams.n_expert_used_max()!=10))
            throw std::runtime_error("8K planning requires exact actual Qwen3Next48/512/top10 geometry");
        uint32_t repack_tensor_count=0;
        for(const auto & item:model->tensors_by_name)
            if(item.second->buffer && strcmp(ggml_backend_buffer_name(item.second->buffer),"CPU_REPACK")==0) repack_tensor_count++;
        if(backend=="cpu" && repack_tensor_count)
            throw std::runtime_error("CPU SSD planning requires standard buffers without weight repacking");
        auto cp=llama_context_default_params();
        cp.n_ctx=context;cp.n_batch=batch;cp.n_ubatch=micro;cp.n_seq_max=1;cp.n_threads=4;cp.n_threads_batch=4;cp.n_rs_seq=0;
        cp.type_k=GGML_TYPE_F16;cp.type_v=GGML_TYPE_F16;cp.swa_full=false;cp.kv_unified=true;
        cp.offload_kqv=backend=="metal";cp.op_offload=backend=="metal";cp.flash_attn_type=LLAMA_FLASH_ATTN_TYPE_AUTO;
        ctx=llama_init_from_model(model,cp);if(!ctx)throw std::runtime_error("metadata-only graph planning failed");
        if(qwen_shape){const auto & actual=ctx->get_cparams();auto * hybrid=dynamic_cast<llama_memory_hybrid*>(ctx->get_memory());
            if(actual.n_ctx!=8192 || actual.n_ctx_seq!=8192 || actual.n_batch!=64 || actual.n_ubatch!=16 || actual.n_seq_max!=1 ||
               actual.n_threads!=4 || actual.n_threads_batch!=4 || actual.n_rs_seq!=0 || actual.offload_kqv || actual.op_offload || !actual.kv_unified ||
               !hybrid || hybrid->get_mem_attn()->type_k()!=GGML_TYPE_F16 || hybrid->get_mem_attn()->type_v()!=GGML_TYPE_F16 || model->hparams.is_swa_any())
                throw std::runtime_error("actual resolved Qwen8K CPU/F16/one-sequence shape was not confirmed");}
        auto mb=llama_get_memory_breakdown(ctx);uint64_t dense=0,kv=0,compute=0,recurrent=0,cache=0;
        for(auto & item:mb){dense+=aligned(item.second.model,item.first);kv+=aligned(item.second.context,item.first);compute+=aligned(item.second.compute,item.first);}
        if(auto * hybrid=dynamic_cast<llama_memory_hybrid*>(ctx->get_memory()))recurrent=sum_memory(hybrid->get_mem_recr());
        else if(auto * hybrid=dynamic_cast<llama_memory_hybrid_iswa*>(ctx->get_memory()))recurrent=sum_memory(hybrid->get_mem_recr());
        if(recurrent>kv)throw std::runtime_error("invalid recurrent/context accounting");kv-=recurrent;
        auto * stream=model->moe_stream();uint32_t groups=0;for(auto & sl:stream->layers)groups+=sl!=nullptr;
        if(qwen_shape && (groups!=48 || stream->n_slots!=30))throw std::runtime_error("8K planning requires all48 streamed groups and exact30-slot cache");
        for(auto & item:stream->ctxs)cache+=aligned(ggml_backend_alloc_ctx_tensors_from_buft_size(item.second.get(),item.first),item.first);
        const uint64_t staging=2*(stream->max_nb_expert+8192);
        const uint64_t output=micro*llama_vocab_n_tokens(llama_model_get_vocab(model))*sizeof(float);
        const uint64_t reserve=256ull*1024*1024;
        uint64_t loading_staging=1024*1024;
        for(const auto & item:model->tensors_by_name) {
            auto * tensor=item.second;
            if(tensor->buffer && strcmp(ggml_backend_buffer_name(tensor->buffer),"CPU_REPACK")==0)
                loading_staging=std::max<uint64_t>(loading_staging,ggml_nbytes(tensor));
        }
        // Cache/context/graphs follow dense loading. CPU_REPACK needs a full
        // tensor upload; ordinary dense buffers accept bounded chunked writes.
        const uint64_t loading_peak=dense+loading_staging+reserve;
        auto mctx=ctx->get_memory()->init_full();auto * graph=ctx->graph_reserve(micro,1,micro,mctx.get(),true);
        const uint64_t workspace=ggml_graph_plan(graph,64,nullptr).work_size;
        const uint64_t total=dense+cache+kv+recurrent+compute+staging+output+reserve+workspace;
        const std::string physical=ggml_ssd_snapshot();
        if(physical.find("\"recurrentBytes\":0,")==std::string::npos)
            throw std::runtime_error("metadata planning allocated recurrent payload");
        rusage_info_v4 process{};struct rusage lifetime{};
        if(proc_pid_rusage(getpid(),RUSAGE_INFO_V4,(rusage_info_t*)&process)!=0 || getrusage(RUSAGE_SELF,&lifetime)!=0 ||
           !process.ri_resident_size || !process.ri_phys_footprint || process.ri_resident_size>limit || process.ri_phys_footprint>limit)
            throw std::runtime_error("native planner final memory measurement failed");
        if(cancelled || ggml_ssd_stopped())throw std::runtime_error("planner cancelled or deadline expired");
        printf("SSD_PLAN {\"schemaVersion\":1,\"workerIdentity\":\"free-local-agent-ssd-v1\",\"baseCommit\":\"d81235049384534c167caea52b85a694f6103d14\",\"patchSha256\":\"%s\",\"plannerSourceSha256\":\"%s\",\"architecture\":\"%s\",\"noAlloc\":true,\"modelPayloadAllocatedBytes\":0,\"mappedColdBytes\":0,\"profile\":{\"backend\":\"%s\",\"contextTokens\":%llu,\"batchTokens\":%llu,\"microBatchTokens\":%llu,\"outputTokens\":%llu,\"cacheTypeK\":\"f16\",\"cacheTypeV\":\"f16\",\"swaFull\":false,\"slots\":1,\"ioWorkers\":2,\"cpuKernel\":\"%s\",\"useExtraBufts\":%s,\"cpuRepackTensorCount\":%u,\"decodeThreads\":4,\"batchThreads\":4,\"ioMode\":\"darwin-nocache\"%s},\"expectedGroups\":%u,\"minimumSlotsPerLayer\":%u,\"cacheSlotsPerLayer\":%u,\"flashAttentionResolved\":%s,\"cpuWorkspaceThreadsBound\":64,\"allocationBudgetBytes\":%llu,\"residentLimitBytes\":%llu,\"cacheBudgetBytes\":%llu,\"loadingDenseStagingBytes\":%llu,\"loadingPeakBytes\":%llu,\"ledger\":{\"denseBytes\":%llu,\"expertCacheBytes\":%llu,\"contextBytes\":%llu,\"recurrentBytes\":%llu,\"scratchBytes\":%llu,\"stagingBytes\":%llu,\"outputBytes\":%llu,\"reservedBytes\":%llu,\"cpuWorkspaceBytes\":%llu,\"totalBytes\":%llu},\"plannerMeasurements\":{\"rssBytes\":%llu,\"physicalFootprintBytes\":%llu,\"peakRssBytes\":%llu,\"peakPhysicalFootprintBytes\":%llu,\"provenance\":\"Darwin current rusage_info_v4 and kernel lifetime maxima\"},\"physicalSample\":%s}\n",
          SSD_PATCH_SHA256,SSD_PLAN_SOURCE_SHA256,model->arch_name().c_str(),backend.c_str(),context,batch,micro,output_tokens,backend=="cpu"?"standard":"default",mp.use_extra_bufts?"true":"false",repack_tensor_count,qwen_shape?",\"kvUnified\":true,\"nRsSeq\":0,\"checkpoints\":0":"",groups,3*model->hparams.n_expert_used_max(),stream->n_slots,
          ctx->get_cparams().flash_attn?"true":"false",budget,limit,cache_budget,loading_staging,loading_peak,dense,cache,kv,recurrent,compute,staging,output,reserve,workspace,total,process.ri_resident_size,process.ri_phys_footprint,uint64_t(lifetime.ru_maxrss),process.ri_lifetime_max_phys_footprint,physical.c_str());
        llama_free(ctx);ctx=nullptr;llama_model_free(model);model=nullptr;llama_backend_free();
        done=true;cancellation.join();ggml_ssd_finish();return 0;
    } catch(const std::exception & e) {
        fprintf(stderr,"SSD_PLAN_ERROR %s\n",e.what());
        if(ctx)llama_free(ctx);if(model)llama_model_free(model);
        done=true;if(cancellation.joinable())cancellation.join();ggml_ssd_finish();return 1;
    }
}
