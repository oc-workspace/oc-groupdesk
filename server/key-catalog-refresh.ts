type Model={model_id:string;source?:string;listed?:boolean;[field:string]:unknown};

export function refreshedKeyModels<T extends Model>(current:T[],previous:T[]):T[]{
 const currentIds=new Set(current.map(model=>model.model_id));
 return [...current,...previous.filter(model=>!currentIds.has(model.model_id)).map(model=>({...model,listed:false}))];
}
