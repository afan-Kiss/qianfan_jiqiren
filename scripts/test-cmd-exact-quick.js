const {spawn}=require("child_process");
const {execSync}=require("child_process");
try{execSync('taskkill /F /IM "千帆客服工作台.exe"',{stdio:"ignore"})}catch{}
setTimeout(()=>{
  spawn('"E:\\千帆\\eva\\千帆客服工作台.exe" --remote-debugging-port=9223',{shell:true,detached:true,stdio:"ignore",windowsHide:false}).unref();
  setTimeout(async()=>{ try{ const r=await fetch("http://127.0.0.1:9223/json/version"); console.log("OK",r.status);}catch(e){console.log("FAIL",e.message);} },8000);
},2000);
