/** Trusted model policies, applied before both token counting and generation. */
export interface ModelGenerationPolicy {
  kind:'default'|'qwen38'|'muse-glimmer';
  preserveThinking:boolean;
  /** Exact trusted local-only execution policy; independent of thinking family. */
  localOnly?:boolean;
  alwaysThinking:boolean;
  helperOutputTokens:number;
  /** Coding may reuse only the existing owned slot. No RAM cache or checkpoints. */
  codingPromptCache?:boolean;
}
export interface ModelGenerationOptions {
  temperature?:number;top_p?:number;top_k?:number;min_p?:number;repeat_penalty?:number;presence_penalty?:number;
  chat_template_kwargs?:Record<string,unknown>;
}
export type CodingModelFamily='qwen38'|'muse-glimmer';
/** An exact curated identity selects family settings, never prior model proof. */
export function codingModelFamily(modelId:string):CodingModelFamily|null {
  if(modelId==='qwen3.8:27b'||modelId==='qwen3.8:27b-q3-k-m')return 'qwen38';
  if(modelId==='muse-glimmer:30b'||modelId==='muse-glimmer:30b-q3-k-m')return 'muse-glimmer';
  return null;
}
/** Eligible to run fresh qualification, not a claim that qualification passed. */
export function isQualificationEligible(modelId:string):boolean{return codingModelFamily(modelId)!==null;}
export function generationPolicyForModel(modelId:string):ModelGenerationPolicy {
  const kind=codingModelFamily(modelId)??'default';
  return {kind,...(modelId==='qwen3-coder-next:80b'?{localOnly:true}:{}),preserveThinking:kind!=='default',alwaysThinking:kind==='muse-glimmer',helperOutputTokens:kind==='muse-glimmer'?8192:kind==='default'?768:2048,
    ...(modelId==='qwen3.8:27b-q3-k-m'||modelId==='muse-glimmer:30b-q3-k-m'?{codingPromptCache:true}:{})};
}
export function modelGenerationOptions(policy:ModelGenerationPolicy|undefined,purpose:'coding'|'helper'|'probe',effort:'standard'|'careful'='standard'):ModelGenerationOptions {
  if(!policy||policy.kind==='default')return purpose==='coding'?{}:{...(purpose==='probe'?{temperature:0}:{}),chat_template_kwargs:{enable_thinking:false}};
  if(policy.kind==='qwen38')return {temperature:purpose==='coding'?1:0,top_p:0.95,top_k:20,min_p:0,repeat_penalty:1,presence_penalty:0,
    chat_template_kwargs:{enable_thinking:purpose==='coding',preserve_thinking:true,reasoning_effort:purpose==='coding'?(effort==='careful'?'xhigh':'medium'):'low'}};
  return {temperature:1,top_p:0.95,top_k:64,min_p:0,repeat_penalty:1,
    chat_template_kwargs:{reasoning_strength:purpose==='coding'?'high':'low',preserve_reasoning:true}};
}
export function usesQualifiedProfiles(modelId:string):boolean{return isQualificationEligible(modelId);}

/** Capabilities are per-turn policy, independent of the model's reasoning family. */
export function modelUsesLocalOnlyExecution(policy: ModelGenerationPolicy | undefined): boolean {
  return policy?.localOnly === true || policy?.kind !== undefined && policy.kind !== 'default';
}
