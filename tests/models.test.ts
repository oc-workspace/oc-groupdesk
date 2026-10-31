import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sealKey,openKey,baseUrl,publicAddress} from '../server/model-security.js';
import {parseCatalog,inferCapability} from '../server/models.js';

test('model credentials use authenticated encryption with independent random nonces',()=>{
  process.env.MODEL_ENCRYPTION_KEY='ab'.repeat(32);
  const raw='isolated-test-secret-value',a=sealKey(raw),b=sealKey(raw);
  assert.notEqual(a,b);assert(!a.includes(raw));assert.equal(openKey(a),raw);
  const parts=a.split('.');parts[2]=Buffer.alloc(16).toString('base64url');
  assert.throws(()=>openKey(parts.join('.')));
  process.env.MODEL_ENCRYPTION_KEY='cd'.repeat(32);assert.throws(()=>openKey(a));
  delete process.env.MODEL_ENCRYPTION_KEY;assert.throws(()=>sealKey(raw));
});
test('catalog URLs forbid embedded credentials, redirects to local URLs and reserved addresses',()=>{
  assert.equal(baseUrl('https://api.example.com/v1/'),'https://api.example.com/v1');
  for(const url of ['http://api.example.com','https://user:password@api.example.com','https://api.example.com/?key=value','https://127.0.0.1','https://169.254.169.254','https://api.local','https://example.com:8443','https://[::1]'])assert.throws(()=>baseUrl(url));
  for(const ip of ['127.0.0.1','10.0.0.1','100.64.1.1','172.16.0.1','192.168.1.1','169.254.169.254','0.0.0.0','192.0.2.1','198.18.0.1','203.0.113.1','224.0.0.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1'])assert(!publicAddress(ip),ip);
  assert(publicAddress('8.8.8.8'));assert(publicAddress('2606:4700:4700::1111'));
});
test('model catalog is bounded, deduplicated and separates text, image, video and uncertain names',()=>{
  const models=parseCatalog({data:[{id:'grok-4.3'},{id:'grok-imagine-image'},{id:'grok-imagine-video'},{id:'grok-imagine'},{id:'grok-4.3'}]});
  assert.equal(models.length,4);assert.deepEqual(models.map(m=>m.capability),['text','image','other','unknown']);
  assert.equal(inferCapability('flux-example'),'image');
  assert.throws(()=>parseCatalog({data:[{id:'bad\nheader'}]}));
  assert.throws(()=>parseCatalog({unexpected:[]}));
});
