// Send the JSON batch on stdin. Credentials are never command arguments or output.
import {readFile} from 'node:fs/promises';
import {importProviderBatch} from '../server/provider-import.js';
import {refreshCatalog} from '../server/models.js';
import {pool} from '../server/db.js';
try{
  const rows=await importProviderBatch(JSON.parse(await readFile('/dev/stdin','utf8')));
  for(const row of rows){
    try{const result=await refreshCatalog(row.id,'operator');console.log(JSON.stringify({name:row.name,catalog_models:result.count}));}
    catch{console.log(JSON.stringify({name:row.name,catalog_error:'目录查询失败；已保留配置参考模型'}));}
  }
}finally{await pool.end();}
