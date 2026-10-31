export function createServerClock(){
  let offset=0;
  return {
    update(header:string|null,receivedAt=Date.now()){
      const timestamp=Date.parse(header||'');
      if(Number.isFinite(timestamp))offset=timestamp-receivedAt;
    },
    now(clientNow=Date.now()){return clientNow+offset;}
  };
}
export const serverClock=createServerClock();
