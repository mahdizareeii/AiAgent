#pragma once
// Private proof inputs. A full pinned source set is mandatory; sparse previews
// and caller-supplied hashes without the strict controller are never sufficient.
#include "nlohmann/json.hpp"
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>
#ifndef QWEN80_RESOURCE_MANIFEST_SHA256
#error "Bind fixture to the verified resource inventory at compilation"
#endif
namespace qwen80_proof {
using json=nlohmann::ordered_json;
constexpr const char * base="d81235049384534c167caea52b85a694f6103d14";
constexpr const char * patch="83139a4fbe858827d75f5050defefa69413718c45335ca5c18e49919c3944bb8";
constexpr const char * set_digest="3d0fd1c8ad6c37fdac38e20b02de80149a5d93b8c457c39e8a27100c8bf62d64";
constexpr const char * template_digest="0b5c439b5b14126c0ae8b14ca93240c3cef1e7e29d684102b07f10727523dbdb";
constexpr const char * revision="b82fb7382639d97b38fa7672e526c760c2fb358e";
inline void require(bool ok,const char * message){if(!ok)throw std::runtime_error(message);}
inline json read_json(const std::string & path){
    const int fd=open(path.c_str(),O_RDONLY|O_CLOEXEC|O_NOFOLLOW);require(fd>=0,"read-only proof input required");
    struct stat st{};if(fstat(fd,&st)!=0 || !S_ISREG(st.st_mode) || st.st_size<2 || st.st_size>1024*1024){close(fd);throw std::runtime_error("bounded regular proof JSON required");}
    std::string text(size_t(st.st_size),'\0');size_t at=0;
    while(at<text.size()){const auto n=read(fd,text.data()+at,text.size()-at);if(n<0 && errno==EINTR)continue;if(n<=0){close(fd);throw std::runtime_error("complete proof JSON read required");}at+=size_t(n);}
    close(fd);return json::parse(text);
}
inline void fingerprint(int fd,const json & fp){struct stat st{};require(fstat(fd,&st)==0 && S_ISREG(st.st_mode),"regular proof source required");
    require(uint64_t(st.st_dev)==fp.at("device") && uint64_t(st.st_ino)==fp.at("inode") && uint64_t(st.st_size)==fp.at("sizeBytes") &&
        st.st_mtimespec.tv_sec==fp.at("mtimeSeconds") && st.st_mtimespec.tv_nsec==fp.at("mtimeNanoseconds") &&
        st.st_ctimespec.tv_sec==fp.at("ctimeSeconds") && st.st_ctimespec.tv_nsec==fp.at("ctimeNanoseconds"),"verified proof source fingerprint changed");
}
inline json source(const std::string & path){auto p=read_json(path);
    require(p.at("schemaVersion")==1 && p.at("completeVerifiedSource")==true && p.at("baseCommit")==base && p.at("patchSha256")==patch &&
        p.at("resourceManifestSha256")==QWEN80_RESOURCE_MANIFEST_SHA256 && p.at("artifactSetDigest")==set_digest &&
        p.at("templateSha256")==template_digest && p.at("repository")=="Qwen/Qwen3-Coder-Next-GGUF" && p.at("revision")==revision,
        "exact official verified Qwen80/native proof binding required");
    static const uint64_t sizes[]={15524827040ull,14872168352ull,14503294496ull,3510702144ull};
    static const char * hashes[]={"6bcfc9f9c37901eeb92172e2ab871224dab36a453d263bcb2547f737409534da","817def0691ee9d08bf3dc4444be7aed29c9e52091e8fa9d97901ce7e7f6f01d3","23aa634d47dca9b4ca3ea249384e6f01951b24c83cdc076f37f6f43d6c99883f","249c768cc5f130dc731567d6edcbdacc48e14dec9e02c5dbe2b2185d2c5bdb2b"};
    require(p.at("geometry")==json({{"layers",48},{"expertsPerLayer",512},{"activeExperts",10},{"minimumSlotsPerLayer",30},{"expectedRoutedTensorGroups",48},{"originalTensorDescriptors",807}}),"exact actual verified full Qwen geometry required");
    require(p.at("artifacts").size()==4,"all four verified Qwen shards required");
    for(size_t i=0;i<4;i++){const auto & a=p.at("artifacts").at(i);const auto expected="Qwen3-Coder-Next-Q4_K_M-0000"+std::to_string(i+1)+"-of-00004.gguf";
        require(a.at("filename")==expected && a.at("sha256")==hashes[i] && a.at("sizeBytes")==sizes[i] && a.at("bytesRead")==sizes[i] && a.at("ioMode")=="darwin-nocache", "full exact uncached Qwen shard verification required");
        const int fd=open(a.at("path").get<std::string>().c_str(),O_RDONLY|O_CLOEXEC|O_NOFOLLOW);require(fd>=0,"verified source descriptor required");try{fingerprint(fd,a.at("fingerprint"));}catch(...){close(fd);throw;}close(fd);
    }return p;
}
inline json fixture(const std::string & path){auto p=read_json(path);
    require(p.at("schemaVersion")==1 && p.at("sourceArtifactSetDigest")==set_digest && p.at("sourceTemplateSha256")==template_digest &&
        p.at("nativePatchSha256")==patch && p.at("resourceManifestSha256")==QWEN80_RESOURCE_MANIFEST_SHA256 &&
        p.at("selectedOriginalLayers")==json::array({0,3}) && p.at("recurrentLayers")==json::array({true,false}) &&
        p.at("inferenceExecuted")==false && p.at("sourceFingerprintUnchanged")==true,"exact private hybrid fixture binding required");
    require(p.at("fixtureSha256").is_string() && p.at("fixtureSha256").get<std::string>().size()==64,"full private fixture digest required");
    const int fd=open(p.at("fixturePath").get<std::string>().c_str(),O_RDONLY|O_CLOEXEC|O_NOFOLLOW);require(fd>=0,"private fixture descriptor required");try{fingerprint(fd,p.at("fixtureFingerprint"));}catch(...){close(fd);throw;}close(fd);return p;
}
}
