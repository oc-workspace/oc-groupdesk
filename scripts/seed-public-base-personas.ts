import {seedPublicBasePersonas} from '../server/public-personas.js';
import {closePools} from '../server/db.js';
try{console.log(JSON.stringify(await seedPublicBasePersonas('operator:user-requested-public-personas')));}
catch{console.error('public_persona_import_failed');process.exitCode=1;}
finally{await closePools();}
