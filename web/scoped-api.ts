export type ScopedTransport=(path:string,method?:string,body?:unknown,signal?:AbortSignal,botId?:string)=>Promise<any>;
// Bind once per mounted workspace. Late callbacks from a closed editor retain
// their original robot rather than following a mutable global selection.
export function bindBotApi(botId:string,transport:ScopedTransport){return (path:string,method='GET',body?:unknown,signal?:AbortSignal)=>transport(path,method,body,signal,botId);}
