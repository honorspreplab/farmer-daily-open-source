(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.FarmerSchedule=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function pacificParts(now){
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(part=>[part.type,part.value]));
    return {date:`${parts.year}-${parts.month}-${parts.day}`,minute:Number(parts.hour)*60+Number(parts.minute)};
  }
  function shouldPrepare({profile,brief,now=Date.now(),visible=true}){
    if(!visible||profile?.scheduleEnabled!==true||!/^([01]\d|2[0-3]):[0-5]\d$/.test(profile.briefTime||''))return false;
    const parts=pacificParts(now),[hour,minute]=profile.briefTime.split(':').map(Number);
    return parts.minute>=hour*60+minute&&brief?.date!==parts.date;
  }
  return {pacificParts,shouldPrepare};
});
