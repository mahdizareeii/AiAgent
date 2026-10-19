// Transport-only early Stop latch. It grants no app/model readiness evidence.
exports.createBootstrapStopLatch = function() {
  const pending=new Set();let nonce=null,stopped=false;
  const valid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
  return {
    receive(message){
      if(message?.type!=='stop'||!valid(message.nonce))return false;
      if(nonce===null){pending.add(message.nonce);if(pending.size>4)throw new Error('Early Stop nonce bound exceeded.');return false;}
      if(message.nonce===nonce)stopped=true;
      return stopped;
    },
    bind(value){if(nonce!==null||!valid(value))throw new Error('An exact fresh bootstrap nonce is required.');nonce=value;stopped=pending.has(nonce);pending.clear();return stopped;},
    get stopped(){return stopped;},
  };
};
