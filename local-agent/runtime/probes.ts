/** Diagnostics capture only the app's fixed local calibration prompts, never user tasks. */
export interface FixedProbeDiagnostic {
  kind:'chat'|'tools';passed:boolean;requestedOutputTokens:number;thinkingDisabled:true;
  finishReason:string|null;content:string|null;reasoning:string|null;outputTokens:number|null;reasoningTokens:number|null;
  toolCalls:{name:string|null;arguments:string|null}[];toolCallCount:number;truncated:boolean;
  binding:{model:string;digest?:string;templateHash?:string;runtime?:string;profileSignature?:string;trialId?:string};
}
export interface FixedProbeResponse {
  choices?:{finish_reason?:unknown;message?:{content?:unknown;reasoning_content?:unknown;reasoning?:unknown;tool_calls?:{function?:{name?:unknown;arguments?:unknown}}[]}}[];
  usage?:{completion_tokens?:unknown;completion_tokens_details?:{reasoning_tokens?:unknown}};
  timings?:{predicted_per_second?:number;predicted_n?:unknown};
}
export function fixedProbeDiagnostic(kind:'chat'|'tools',result:FixedProbeResponse,requestedOutputTokens:number,passed:boolean,binding:FixedProbeDiagnostic['binding']):FixedProbeDiagnostic{
  let truncated=false;const text=(value:unknown,limit=512):string|null=>{if(typeof value!=='string')return null;if(value.length>limit)truncated=true;return value.slice(0,limit);};
  const count=(value:unknown):number|null=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
  const choice=result.choices?.[0],message=choice?.message,calls=Array.isArray(message?.tool_calls)?message!.tool_calls!:[];if(calls.length>2)truncated=true;
  return {kind,passed,requestedOutputTokens,thinkingDisabled:true,finishReason:text(choice?.finish_reason,64),content:text(message?.content),reasoning:text(message?.reasoning_content??message?.reasoning),outputTokens:count(result.usage?.completion_tokens)??count(result.timings?.predicted_n),reasoningTokens:count(result.usage?.completion_tokens_details?.reasoning_tokens),toolCalls:calls.slice(0,2).map(c=>({name:text(c?.function?.name,128),arguments:text(c?.function?.arguments)})),toolCallCount:calls.length,truncated,binding:{...binding}};
}
export function probeFailureDetail(probe:FixedProbeDiagnostic):string{
  return `finish=${probe.finishReason??'unreported'}, output tokens=${probe.outputTokens??'unreported'}/${probe.requestedOutputTokens}, content=${JSON.stringify(probe.content)}, reasoning=${JSON.stringify(probe.reasoning)}, tool calls=${probe.toolCallCount}${probe.truncated?' (bounded excerpt)':''}`;
}
