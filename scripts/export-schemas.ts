import {mkdir,writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {topicPolicySchema,groupPolicySchema,catalog} from '../server/policies.js';
await mkdir(new URL('../schemas/',import.meta.url),{recursive:true});
for(const [name,schema] of [['topic-pack',topicPolicySchema],['group-policy',groupPolicySchema]] as const){
  await writeFile(new URL('../schemas/'+name+'.schema.json',import.meta.url),JSON.stringify(z.toJSONSchema(schema),null,2)+'\n');
}
console.log('Validated catalog:',(await catalog()).length,'topics');
