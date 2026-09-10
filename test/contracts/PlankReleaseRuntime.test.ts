import {expect} from 'chai';
import {readFile} from 'node:fs/promises';
import {ethers} from './helpers/hardhat.js';
import {assertRuntime} from '../../scripts/lib/plankcrash-real-soak-validation.js';
describe('Release runtime identity',()=>{
 it('matches a real beacon with constructor immutables and rejects a mock',async()=>{
  const f=JSON.parse(await readFile('test/contracts/fixtures/drand-round.json','utf8'));
  const real=await (await ethers.getContractFactory('DrandBeacon')).deploy(f.chainHash,f.publicKey,f.genesis,f.period,ethers.toUtf8Bytes(f.domain));
  const mock=await (await ethers.getContractFactory('DrandBeaconMock')).deploy(f.period,f.genesis);
  expect(await assertRuntime(ethers.provider as any,await real.getAddress(),'DrandBeacon')).eq(ethers.keccak256(await ethers.provider.getCode(await real.getAddress())));
  let rejected=false;try{await assertRuntime(ethers.provider as any,await mock.getAddress(),'DrandBeacon');}catch{rejected=true;}
  expect(rejected).eq(true);
 });
});
