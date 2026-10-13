/** Immutable publisher revisions and LFS SHA-256 values, checked 2026-10-13. */
export interface ModelArtifact { filename:string; remotePath?:string; sizeBytes:number; sha256:string; }
export interface ModelTaskGuidance { id:'coding'|'websites'|'automation'|'documents'|'research'; label:string; icon:string; description:string; examples:string[]; }
export interface CuratedModel {
  id: string; title: string; description: string; estimatedDownloadBytes: number;
  minimumMemoryGB: number; license: string; sourceUrl: string; quantization: string;
  repository: string; revision: string; filename: string; sha256: string;
  architecture: string; toolCapable: boolean; workingMemoryGB: number;
  artifacts?:readonly ModelArtifact[]; taskGuidance?:readonly ModelTaskGuidance[];
  ssd?:{minimumSlotsPerLayer:number;expertsPerLayer:number;activeExperts:number;expectedLayers:number};
  emitsThinking?:boolean;
}
export const MODEL_CATALOG: readonly CuratedModel[] = Object.freeze([
  {id:'qwen3.5:4b',title:'Qwen3.5 4B',description:'Compact coding and research model.',estimatedDownloadBytes:2740937888,minimumMemoryGB:8,license:'Apache-2.0',sourceUrl:'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF',quantization:'Q4_K_M',repository:'unsloth/Qwen3.5-4B-GGUF',revision:'e87f176479d0855a907a41277aca2f8ee7a09523',filename:'Qwen3.5-4B-Q4_K_M.gguf',sha256:'00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',architecture:'qwen35',toolCapable:true,workingMemoryGB:4.5},
  {id:'qwen3.5:9b',title:'Qwen3.5 9B',description:'Larger coding and research model.',estimatedDownloadBytes:5680522464,minimumMemoryGB:16,license:'Apache-2.0',sourceUrl:'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF',quantization:'Q4_K_M',repository:'unsloth/Qwen3.5-9B-GGUF',revision:'3885219b6810b007914f3a7950a8d1b469d598a5',filename:'Qwen3.5-9B-Q4_K_M.gguf',sha256:'03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',architecture:'qwen35',toolCapable:true,workingMemoryGB:8},
  {id:'gemma4:12b',title:'Gemma 4 12B',description:'Balanced general reasoning, coding and tool use.',estimatedDownloadBytes:6975879296,minimumMemoryGB:16,license:'Apache-2.0',sourceUrl:'https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf',quantization:'QAT Q4_0',repository:'google/gemma-4-12B-it-qat-q4_0-gguf',revision:'29d097773436b69ff9feafd636ab4cf873786537',filename:'gemma-4-12b-it-qat-q4_0.gguf',sha256:'93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b',architecture:'gemma4',toolCapable:true,workingMemoryGB:10},
  {id:'gemma4:26b',title:'Gemma 4 26B A4B',description:'MoE reasoning model. Experimental SSD streaming can trade speed for lower RAM use.',estimatedDownloadBytes:14439363584,minimumMemoryGB:24,license:'Apache-2.0',sourceUrl:'https://huggingface.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf',quantization:'QAT Q4_0',repository:'google/gemma-4-26B-A4B-it-qat-q4_0-gguf',revision:'d1c082be9cf3c8a514acf63b8761f4b41935842e',filename:'gemma-4-26B_q4_0-it.gguf',sha256:'3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d',architecture:'gemma4',toolCapable:true,workingMemoryGB:19,ssd:{minimumSlotsPerLayer:24,expertsPerLayer:128,activeExperts:8,expectedLayers:30}},
  {id:'gemma4:31b',title:'Gemma 4 31B',description:'Dense reasoning model for computers with more memory.',estimatedDownloadBytes:17651001568,minimumMemoryGB:32,license:'Apache-2.0',sourceUrl:'https://huggingface.co/google/gemma-4-31B-it-qat-q4_0-gguf',quantization:'QAT Q4_0',repository:'google/gemma-4-31B-it-qat-q4_0-gguf',revision:'59dde24573e7e61570dba08b18a2e1fe246955ed',filename:'gemma-4-31B_q4_0-it.gguf',sha256:'179cfb99212709597eae5929112cfca677e1bbf566178b479ae1da0c4772874b',architecture:'gemma4',toolCapable:true,workingMemoryGB:23},
  {id:'qwen3-coder-next:80b',title:'Qwen3-Coder-Next 80B',description:'Coding-focused MoE with 3B active parameters. Requires the complete 45.09 GiB download for local use.',estimatedDownloadBytes:48410992032,minimumMemoryGB:64,license:'Apache-2.0',sourceUrl:'https://huggingface.co/Qwen/Qwen3-Coder-Next-GGUF',quantization:'Q4_K_M',repository:'Qwen/Qwen3-Coder-Next-GGUF',revision:'b82fb7382639d97b38fa7672e526c760c2fb358e',filename:'Qwen3-Coder-Next-Q4_K_M-00001-of-00004.gguf',sha256:'6bcfc9f9c37901eeb92172e2ab871224dab36a453d263bcb2547f737409534da',architecture:'qwen3next',toolCapable:true,workingMemoryGB:52,emitsThinking:false,ssd:{minimumSlotsPerLayer:30,expertsPerLayer:512,activeExperts:10,expectedLayers:48},artifacts:[
    {filename:'Qwen3-Coder-Next-Q4_K_M-00001-of-00004.gguf',remotePath:'Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M-00001-of-00004.gguf',sizeBytes:15524827040,sha256:'6bcfc9f9c37901eeb92172e2ab871224dab36a453d263bcb2547f737409534da'},
    {filename:'Qwen3-Coder-Next-Q4_K_M-00002-of-00004.gguf',remotePath:'Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M-00002-of-00004.gguf',sizeBytes:14872168352,sha256:'817def0691ee9d08bf3dc4444be7aed29c9e52091e8fa9d97901ce7e7f6f01d3'},
    {filename:'Qwen3-Coder-Next-Q4_K_M-00003-of-00004.gguf',remotePath:'Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M-00003-of-00004.gguf',sizeBytes:14503294496,sha256:'23aa634d47dca9b4ca3ea249384e6f01951b24c83cdc076f37f6f43d6c99883f'},
    {filename:'Qwen3-Coder-Next-Q4_K_M-00004-of-00004.gguf',remotePath:'Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M-00004-of-00004.gguf',sizeBytes:3510702144,sha256:'249c768cc5f130dc731567d6edcbdacc48e14dec9e02c5dbe2b2185d2c5bdb2b'},
  ]},
].map(spec=>Object.freeze({...spec,taskGuidance:taskGuidance(spec.architecture)})));
export function modelArtifacts(spec:CuratedModel):readonly ModelArtifact[]{
  return spec.artifacts??[{filename:spec.filename,sizeBytes:spec.estimatedDownloadBytes,sha256:spec.sha256}];
}
function taskGuidance(architecture:string):ModelTaskGuidance[]{
  const coding=architecture==='qwen3next';
  return [
    {id:'coding',label:'Coding',icon:'code',description:coding?'Publisher-trained for coding and agent tasks. Local task checks establish what works here.':'Intended for coding and debugging; local verification is required.',examples:['Python','JavaScript','Node.js']},
    {id:'websites',label:'Websites',icon:'globe',description:'Can generate and edit website files through approved tools. Framework and server prerequisites are separate.',examples:['React','WordPress','HTML/CSS']},
    {id:'automation',label:'Automation',icon:'terminal',description:'Can propose scripts and run approved commands with your permissions.',examples:['Shell','CLI tools']},
    {id:'documents',label:'Documents',icon:'file-text',description:'Text and text-PDF reading, writing and summaries through local utilities.',examples:['Text','PDF']},
    {id:'research',label:'Research',icon:'search',description:'Local project analysis; current web sources require the optional Research plugin.',examples:['Project files','Web sources when enabled']},
  ];
}
