// Tests the actual bundled server argument parser and model/context conversion.
// It never calls model loading, context construction, downloads, or server startup.
#include "arg.h"
#include "common.h"
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>
static int checks=0;
static void check(bool ok,const char * reason){if(!ok)throw std::runtime_error(reason);checks++;}
static void parse(std::vector<std::string> flags,bool extra,int threads=-1){
    common_params params;std::vector<std::string> words={"llama-server-ssd"};words.insert(words.end(),flags.begin(),flags.end());std::vector<char*> argv;
    for(auto & word:words)argv.push_back(word.data());
    check(common_params_parse(argv.size(),argv.data(),params,LLAMA_EXAMPLE_SERVER),"official server flag parsing");
    const auto model=common_model_params_to_llama(params);check(model.use_extra_bufts==extra,"server model params honor repacking flag");
    if(threads>0){const auto context=common_context_params_to_llama(params);check(context.n_threads==threads && context.n_threads_batch==threads,"server context params honor fixed decode/batch thread flags");}
}
int main(){try{
    parse({},true);
    parse({"--no-repack"},false);
    parse({"-nr"},false);
    parse({"--repack"},true);
    parse({"--no-repack","--threads","4","--threads-batch","4"},false,4);
    printf("SSD_SERVER_KERNEL_FLAGS {\"checks\":%d,\"passed\":true,\"modelsLoaded\":0,\"contextsCreated\":0,\"inferenceCalls\":0}\n",checks);return 0;
  }catch(const std::exception & e){fprintf(stderr,"SSD_SERVER_KERNEL_FLAGS_ERROR %s\n",e.what());return 1;}}
