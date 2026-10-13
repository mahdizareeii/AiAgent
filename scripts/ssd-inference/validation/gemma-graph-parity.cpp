// Private partial-model CPU graph diagnostics. Build only until explicitly authorized.
#include "llama.h"
#include "llama-ext.h"
#include "llama-model.h"
#include "llama-context.h"
#include "llama-moe-stream.h"
#include "ggml-cpu.h"
#include "ggml-ssd-policy.h"
#include "nlohmann/json.hpp"
#include <libproc.h>
#include <mach/mach.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <fcntl.h>
#include <unistd.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstring>
#include <fstream>
#include <map>
#include <stdexcept>
#include <thread>
#include <vector>
#ifndef FIXTURE_PATCH_SHA256
#error "Bind to the frozen native patch"
#endif
using json=nlohmann::ordered_json;
static volatile sig_atomic_t interrupted=0;
static bool use_extra_bufts=false;
static void on_signal(int){interrupted=1;}
static constexpr uint64_t GiB=1024ull*1024*1024,MiB=1024ull*1024;
static constexpr uint64_t capture_budget=64*MiB;
static constexpr const char * fixture_sha="40928e674a3801e81e230acb6b9cfefd4a3648d05cb93b959626f2241a5a7fa1";
static void check(bool ok,const char * message){if(!ok)throw std::runtime_error(message);}
static uint64_t integer(const std::string & s){check(!s.empty() && std::all_of(s.begin(),s.end(),[](char c){return c>='0' && c<='9';}),"strict decimal integer expected");return std::stoull(s);}
struct measurement {uint64_t rss=0,foot=0,available=0,total=0;int pressure=0;bool valid=false;};
static measurement measure(){measurement m;rusage_info_v4 usage{};vm_statistics64_data_t vm{};vm_size_t page=0;auto host=mach_host_self();mach_msg_type_number_t count=HOST_VM_INFO64_COUNT;
  m.valid=proc_pid_rusage(getpid(),RUSAGE_INFO_V4,(rusage_info_t*)&usage)==0 && host_page_size(host,&page)==KERN_SUCCESS && host_statistics64(host,HOST_VM_INFO64,(host_info64_t)&vm,&count)==KERN_SUCCESS;
  mach_port_deallocate(mach_task_self(),host);size_t n=sizeof(m.pressure),total_n=sizeof(m.total);
  m.valid=m.valid && sysctlbyname("kern.memorystatus_vm_pressure_level",&m.pressure,&n,nullptr,0)==0 && sysctlbyname("hw.memsize",&m.total,&total_n,nullptr,0)==0;
  m.rss=usage.ri_resident_size;m.foot=usage.ri_phys_footprint;m.available=(uint64_t(vm.free_count)+vm.inactive_count+vm.speculative_count)*page;
  m.valid=m.valid && page && m.rss && m.foot && (m.pressure==1 || m.pressure==2);return m;
}
static json measured(const measurement & m){return {{"rssBytes",m.rss},{"physicalFootprintBytes",m.foot},{"availableRamBytes",m.available},{"pressureLevel",m.pressure},{"valid",m.valid}};}
static std::pair<uint64_t,uint64_t> fresh_limits(const measurement & m,uint64_t a,uint64_t t){
  check(m.valid && m.available>GiB && m.total>2*GiB,"valid fresh monitored hardware required");
  const auto os_reserve=std::max<uint64_t>(2*GiB,m.total/5);check(m.total>os_reserve,"invalid OS headroom");
  t=std::min({t,7*GiB/2,m.total-os_reserve,m.available-GiB});
  check(t>512*MiB,"not enough resident headroom");a=std::min({a,3*GiB,t-512*MiB});check(a>=256*MiB,"not enough allocation headroom");return {a,t};
}
static auto deadline=std::chrono::steady_clock::now();
static void live(){check(!interrupted && !ggml_ssd_stopped() && std::chrono::steady_clock::now()<deadline,"partial graph cancelled or expired");}
struct model_owner {
  llama_model * model=nullptr;llama_context * context=nullptr;
  ~model_owner(){if(context)llama_free(context);if(model)llama_model_free(model);}
};
static llama_model_params model_params(bool streamed,bool plan){auto p=llama_model_default_params();static ggml_backend_dev_t cpu[]={nullptr};
  p.devices=cpu;p.n_gpu_layers=0;p.load_mode=LLAMA_LOAD_MODE_NONE;p.lazy_mode=LLAMA_LAZY_MODE_OFF;p.no_alloc=plan;p.load_mtp=false;p.use_extra_bufts=use_extra_bufts;
  p.moe_stream=streamed;p.moe_stream_slots=24;p.moe_stream_budget=168000000;p.moe_stream_io_threads=2;
  p.progress_callback=[](float,void*){return !interrupted && !ggml_ssd_stopped() && std::chrono::steady_clock::now()<deadline;};return p;
}
static llama_context_params context_params(){auto p=llama_context_default_params();p.n_ctx=4096;p.n_batch=64;p.n_ubatch=16;p.n_seq_max=1;
  p.n_threads=4;p.n_threads_batch=4;p.type_k=GGML_TYPE_F16;p.type_v=GGML_TYPE_F16;p.swa_full=false;p.kv_unified=true;p.offload_kqv=false;p.op_offload=false;
  p.flash_attn_type=LLAMA_FLASH_ATTN_TYPE_AUTO;p.abort_callback=[](void*){return interrupted || ggml_ssd_stopped() || std::chrono::steady_clock::now()>=deadline;};return p;
}
static void validate(model_owner & p,bool streamed,bool no_alloc){check(p.model && p.context && p.model->arch_name()=="gemma4" && p.model->hparams.n_layer()==2 && p.model->hparams.no_alloc==no_alloc &&
    p.model->hparams.is_swa(0) && p.model->hparams.is_swa(1) && p.model->hparams.n_expert_used_max()==8 &&
    bool(p.model->moe_stream())==streamed,"strict computational fixture model/profile");
  if(!use_extra_bufts)for(const auto & named:p.model->tensors_by_name)if(named.second->buffer)check(strcmp(ggml_backend_buffer_name(named.second->buffer),"CPU_REPACK")!=0,"matched control must not use CPU_REPACK weights");
  const auto native=json::parse(ggml_ssd_snapshot());
  check(native["patchSha256"]==FIXTURE_PATCH_SHA256,"actual native library patch identity");
  check(native["decodeThreads"]==4 && native["batchThreads"]==4,"actual native context thread proof");
  if(!use_extra_bufts)check(native["cpuKernel"]=="standard" && native["useExtraBufts"]==false && native["cpuRepackTensorCount"]==0,"actual assigned-buffer standard CPU proof");
  if(streamed){auto * stream=p.model->moe_stream();check(stream->n_slots==24 && stream->layer(0) && stream->layer(1),"both partial routed groups must stream with 24 slots");}
}
static json plan(const std::string & path,bool streamed){model_owner p;p.model=llama_model_load_from_file(path.c_str(),model_params(streamed,true));check(p.model,"partial metadata-only model planning");
  p.context=llama_init_from_model(p.model,context_params());validate(p,streamed,true);uint64_t dense=0,kv=0,scratch=0,cache=0;
  for(const auto & item:llama_get_memory_breakdown(p.context)){dense+=item.second.model;kv+=item.second.context;scratch+=item.second.compute;}
  uint64_t staging=0;if(streamed){auto * stream=p.model->moe_stream();for(auto & item:stream->ctxs)cache+=ggml_backend_alloc_ctx_tensors_from_buft_size(item.second.get(),item.first);staging=2*(stream->max_nb_expert+8192);}
  const auto output=16ull*llama_vocab_n_tokens(llama_model_get_vocab(p.model))*sizeof(float);uint64_t loading_staging=MiB;
  for(const auto & item:p.model->tensors_by_name)if(item.second->buffer && strcmp(ggml_backend_buffer_name(item.second->buffer),"CPU_REPACK")==0)loading_staging=std::max<uint64_t>(loading_staging,ggml_nbytes(item.second));
  auto memory=p.context->get_memory()->init_full();auto * graph=p.context->graph_reserve(16,1,16,memory.get(),true);const auto workspace=ggml_graph_plan(graph,64,nullptr).work_size;
  const auto loading_peak=dense+loading_staging+256*MiB;const auto steady=dense+cache+kv+scratch+staging+output+workspace+256*MiB+capture_budget;
  live();return {{"mode",streamed?"streamed":"ordinary"},{"useExtraBufts",use_extra_bufts},{"noAlloc",true},{"modelPayloadAllocatedBytes",0},{"denseBytes",dense},{"expertCacheBytes",cache},
    {"contextBytes",kv},{"scratchBytes",scratch},{"stagingBytes",staging},{"outputBytes",output},{"cpuWorkspaceBytes",workspace},{"reservedBytes",256*MiB},
    {"qaCaptureBudgetBytes",capture_budget},{"steadyBytes",steady},{"loadingDenseStagingBytes",loading_staging},{"loadingPeakBytes",loading_peak},{"requiredBytes",std::max(loading_peak,steady)},
    {"flashAttentionResolved",p.context->get_cparams().flash_attn},{"profile",{{"backend","cpu"},{"contextTokens",4096},{"batchTokens",64},{"microBatchTokens",16},{"threads",4},{"slots",1},{"ioWorkers",2},{"cacheSlotsPerLayer",streamed?24:0},{"cacheTypeK","f16"},{"cacheTypeV","f16"},{"swaFull",false}}}};
}
struct captures {
  int fd=-1;uint64_t at=0;json nodes=json::array();std::string which,error;int case_id=-1,step=0;
  std::map<std::string,int> occurrences;
  ~captures(){if(fd>=0)close(fd);}
  bool wanted(const char * name){const std::string n=name;return n.rfind("ffn_moe_",0)==0 || n.rfind("l_out-",0)==0 || n=="result_output" || n=="result_norm";}
  void record(const std::string & name,ggml_type type,const int64_t * dims,const uint8_t * data,uint64_t bytes){
    check(bytes<=32*MiB && at<=768*MiB && bytes<=768*MiB-at,"bounded private diagnostic output");live();const auto begin=at;
    for(uint64_t wrote=0;wrote<bytes;){auto n=pwrite(fd,data+wrote,std::min<uint64_t>(MiB,bytes-wrote),at);if(n<0 && errno==EINTR)continue;check(n>0,"private graph readback write");at+=n;wrote+=n;}
    uint64_t nonfinite=0;if(type==GGML_TYPE_F32)for(uint64_t i=0;i<bytes/4;i++){float x;memcpy(&x,data+4*i,4);nonfinite+=!std::isfinite(x);}
    const auto occurrence=occurrences[name]++;
    nodes.push_back({{"caseId",case_id},{"step",step},{"name",name},{"occurrence",occurrence},{"type",ggml_type_name(type)},
      {"dimensions",{dims[0],dims[1],dims[2],dims[3]}},{"offset",begin},{"bytes",bytes},{"nonfinite",nonfinite}});
    check(!nonfinite,"nonfinite full-graph diagnostic tensor");
  }
  static bool callback(ggml_tensor * t,bool ask,void * user){auto & c=*static_cast<captures*>(user);if(ask)return c.wanted(t->name);
    try{check(t->type==GGML_TYPE_F32 || t->type==GGML_TYPE_I32,"diagnostic capture only F32/I32");const uint64_t raw_bytes=ggml_nbytes(t),logical_bytes=ggml_nelements(t)*4;
      check(raw_bytes<=32*MiB && logical_bytes<=32*MiB,"bounded native tensor readback");std::vector<uint8_t> raw(raw_bytes),logical(logical_bytes);
      ggml_backend_tensor_get(t,raw.data(),0,raw_bytes);uint64_t out=0;
      for(int64_t i3=0;i3<t->ne[3];i3++)for(int64_t i2=0;i2<t->ne[2];i2++)for(int64_t i1=0;i1<t->ne[1];i1++)for(int64_t i0=0;i0<t->ne[0];i0++){
        const uint64_t in=i0*t->nb[0]+i1*t->nb[1]+i2*t->nb[2]+i3*t->nb[3];check(in<=raw_bytes && 4<=raw_bytes-in,"strided tensor bound");memcpy(logical.data()+out,raw.data()+in,4);out+=4;}
      c.record(t->name,t->type,t->ne,logical.data(),logical_bytes);return true;
    }catch(const std::exception & e){c.error=e.what();ggml_ssd_cancel("QA capture failure");return false;}}
};
static json run(const std::string & path,bool streamed,const std::string & prefix){
  captures evidence;evidence.which=streamed?"streamed":"ordinary";
  evidence.fd=open((prefix+".bin").c_str(),O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);check(evidence.fd>=0,"new private evidence file required");
  check(fcntl(evidence.fd,F_NOCACHE,1)==0 && fcntl(evidence.fd,F_RDAHEAD,0)==0,"private evidence uncached descriptor");
  model_owner p;p.model=llama_model_load_from_file(path.c_str(),model_params(streamed,false));check(p.model,"partial-model weights load");
  auto cp=context_params();cp.cb_eval=captures::callback;cp.cb_eval_user_data=&evidence;p.context=llama_init_from_model(p.model,cp);validate(p,streamed,false);
  ggml_ssd_bytes capture_charge(capture_budget,GGML_SSD_SCRATCH);
  const std::vector<int> lengths={1,3,4,5,16,16};json cases=json::array();
  for(size_t ci=0;ci<lengths.size();ci++){
    live();llama_memory_clear(llama_get_memory(p.context),true);evidence.case_id=ci;evidence.step=0;evidence.occurrences.clear();
    std::vector<llama_token> tokens(lengths[ci]);for(size_t j=0;j<tokens.size();j++)tokens[j]=ci==5?101:101+((j*7919+ci*13)%150000);
    const int steps=ci==4 || ci==5?3:1;json decode_steps=json::array();
    for(int step=0;step<steps;step++){
      evidence.step=step;evidence.occurrences.clear();auto batch=llama_batch_init(step==0?tokens.size():1,0,1);batch.n_tokens=step==0?tokens.size():1;
      for(int i=0;i<batch.n_tokens;i++){batch.token[i]=step==0?tokens[i]:101+((ci*263+step*17)%150000);batch.pos[i]=step==0?i:int(tokens.size())+step-1;batch.n_seq_id[i]=1;batch.seq_id[i][0]=0;batch.logits[i]=true;}
      const auto started=std::chrono::steady_clock::now();const auto result=llama_decode(p.context,batch);llama_synchronize(p.context);llama_batch_free(batch);
      check(result==0 && evidence.error.empty(),"partial teacher-forced decode/capture failed");live();
      const auto nv=llama_vocab_n_tokens(llama_model_get_vocab(p.model));const int outputs=step==0?tokens.size():1;
      for(int i=0;i<outputs;i++){auto * values=llama_get_logits_ith(p.context,i);check(values,"complete output logits available");const int64_t dims[]={nv,1,1,1};
        evidence.record("API_logits_output_"+std::to_string(i),GGML_TYPE_F32,dims,reinterpret_cast<const uint8_t*>(values),uint64_t(nv)*sizeof(float));}
      decode_steps.push_back({{"step",step},{"tokens",step==0?tokens.size():1},{"elapsedSeconds",std::chrono::duration<double>(std::chrono::steady_clock::now()-started).count()}});
    }
    cases.push_back({{"caseId",ci},{"name",ci==5?"repeated-prefix-warm-decode":"varied-fixed-token-prefill"},{"prefillTokens",tokens},{"steps",decode_steps}});
  }
  fsync(evidence.fd);live();return {{"mode",evidence.which},{"partialModelOnly",true},{"cases",cases},{"captures",evidence.nodes},{"captureBytes",evidence.at},{"finalNativeLedger",json::parse(ggml_ssd_snapshot())}};
}
int main(int argc,char ** argv){std::atomic<bool> done{false};std::thread watcher;
  try{
    std::map<std::string,std::string> args;const std::vector<std::string> allowed={"--model","--fixture-sha256","--kernel-control","--mode","--out-prefix","--allocation-budget-bytes","--resident-limit-bytes","--deadline-ms"};
    for(int i=1;i<argc;i+=2)check(i+1<argc && std::find(allowed.begin(),allowed.end(),argv[i])!=allowed.end() && args.emplace(argv[i],argv[i+1]).second,"strict private graph arguments");
    for(const auto & a:allowed)check(args.count(a),"missing private graph argument");check(args["--fixture-sha256"]==fixture_sha,"fixture full digest must match separately verified private artifact");
    const auto kernel=args["--kernel-control"];check(kernel=="standard" || kernel=="default","strict standard/default kernel control");use_extra_bufts=kernel=="default";
    const auto mode=args["--mode"];check(mode=="plan-ordinary" || mode=="plan-streamed" || mode=="ordinary" || mode=="streamed","exact private plan/run mode");
    const bool streamed=mode=="streamed" || mode=="plan-streamed",plan_only=mode.rfind("plan-",0)==0;
    auto duration=integer(args["--deadline-ms"]);check(duration>0 && duration<=300000,"maximum five-minute native deadline");deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(duration);
    auto requested_a=integer(args["--allocation-budget-bytes"]),requested_t=integer(args["--resident-limit-bytes"]);check(requested_a<=3*GiB && requested_t<=7*GiB/2 && requested_a<=requested_t,"private QA budget caps");
    auto initial=measure();const auto budgets=fresh_limits(initial,requested_a,requested_t);const auto a=budgets.first,t=budgets.second;
    signal(SIGTERM,on_signal);signal(SIGINT,on_signal);ggml_ssd_start(a,t,duration);if(streamed)ggml_ssd_cache_budget(168000000);
    watcher=std::thread([&]{while(!done){auto m=measure();fprintf(stderr,"GRAPH_QA_SAMPLE %s\n",measured(m).dump().c_str());fflush(stderr);
      if(interrupted || std::chrono::steady_clock::now()>=deadline || !m.valid || m.rss>t || m.foot>t || m.available<512*MiB){fprintf(stderr,"GRAPH_QA_STOPPED sampled safeguard/deadline\n");std::_Exit(75);}
      for(int i=0;i<40 && !done;i++)std::this_thread::sleep_for(std::chrono::milliseconds(50));}});
    llama_backend_init();const auto sizing=plan(args["--model"],streamed);const bool admitted=sizing["requiredBytes"].get<uint64_t>()<=a;
    printf("GRAPH_QA_PLAN %s\n",sizing.dump().c_str());fflush(stdout);
    json output={{"scope","Partial-model computational CPU equivalence only, not model language/task quality or whole-model correctness."},{"patchSha256",FIXTURE_PATCH_SHA256},
      {"fixtureSha256",fixture_sha},{"useExtraBufts",use_extra_bufts},{"matchedKernelControl",!use_extra_bufts},{"mode",mode},{"allocationBudgetBytes",a},{"residentLimitBytes",t},{"initialMeasurement",measured(initial)},{"plan",sizing},{"admitted",admitted},{"inferenceExecuted",!plan_only},
      {"admissionReason",admitted?"Exact native loading/steady plan fits the fresh capped allocation budget":"Exact native loading/steady plan exceeds the fresh capped allocation budget"}};
    if(!plan_only){check(admitted,"exact native partial-model loading/steady plan exceeds fresh allocation budget");const auto fresh=fresh_limits(measure(),a,t);check(fresh.first>=a && fresh.second>=t,"fresh budget fell after metadata planning; requires explicit new trial");output["run"]=run(args["--model"],streamed,args["--out-prefix"]);}
    output["finalMeasurement"]=measured(measure());live();
    const auto report=args["--out-prefix"]+".json";check(access(report.c_str(),F_OK)!=0 && errno==ENOENT,"private report must be new");std::ofstream f(report);check(bool(f),"private result report open");f<<output.dump(2)<<'\n';f.close();
    llama_backend_free();done=true;watcher.join();ggml_ssd_finish();printf("GRAPH_QA_COMPLETE %s\n",json({{"mode",mode},{"inferenceExecuted",!plan_only},{"admitted",admitted},{"report",report}}).dump().c_str());return admitted?0:2;
  }catch(const std::exception & e){fprintf(stderr,"GRAPH_QA_ERROR %s\n",e.what());done=true;if(watcher.joinable())watcher.join();ggml_ssd_finish();return 1;}
}
