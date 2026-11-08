import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installationPrompt} from '../shared/installation-guide.js';
test('computer asks local AI to detect system; server asks for target verification and preserves data',()=>{const b={id:'synthetic-id',name:'Synthetic name',wechat_id:'synthetic_wechat'};const pc=installationPrompt(b,'unknown','https://example.com','computer'),srv=installationPrompt(b,'unknown','https://example.com','server');assert(pc.includes('自己的电脑'));assert(pc.includes('Windows/macOS/Linux'));assert(srv.includes('自己的服务器'));for(const p of [pc,srv]){assert(p.includes('没有设备执行能力'));assert(p.includes('不执行全局 prune'));assert(p.includes('不能假装一键安装已完成'));assert(p.includes('先执行第一阶段的只读检查，暂不安装'));}});
