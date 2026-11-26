const {createAccess,respond,handleError,HttpError}=require('../shared/access');
const progress=require('../shared/build-progress');
function createBuildStatusHandler(options={}) {
  const access=createAccess(options);
  return async(context,req)=>{
    try{
      if(req.method!=='GET')throw new HttpError(405,'Method not allowed');
      await access.requireAccess(req,{admin:true});
      respond(context,200,{...progress,meaning:{'Not started':'No working integration','Building':'Implementation or external configuration incomplete','Working':'Implemented, verification pending','Validated':'Automated and local integration checks passed; not a guarantee of provider uptime'},limitations:['No closed-app scheduler or background push worker','Optional OpenAI requires server enablement, a budget and separate per-request consent; generated text is not agronomic validation','USDA AMS, NASS and AirNow require server-side API keys','Ecology must expose a verified current-year drought layer before current declarations are shown','Satellite previews use bounded clear-pixel samples, not crop diagnoses or a seasonal historical baseline','No Phase 4 live sensor or equipment integration connected','Calendar connections require administrator provider setup and individual consent; no email or automatic sync']});
    }catch(error){handleError(context,error);}
  };
}
module.exports=createBuildStatusHandler();
module.exports.createBuildStatusHandler=createBuildStatusHandler;
