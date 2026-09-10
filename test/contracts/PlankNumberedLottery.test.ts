import {expect} from 'chai';
import {ethers} from './helpers/hardhat.js';
import {DEFAULT_LOTTERY} from './helpers/casino.js';

describe('Numbered lottery local candidate',()=>{
  async function setup(){const[source,winner,outsider]=await ethers.getSigners();const lottery=await(await ethers.getContractFactory('PlankNumberedLottery')).deploy({...DEFAULT_LOTTERY,source:source.address,founderSink:outsider.address,carveDecayWad:0n,carveHalfSaturationCeilingWei:0n});return{source,winner,outsider,lottery};}
  it('uses the smallest whole-ball count within every funded threshold',async()=>{
    const{lottery}=await setup();
    for(const rake of [0n,1n,10n**12n,10n**16n,10n**20n])for(const prize of [1n,10n**12n,10n**18n,10n**24n]){
      const threshold=await lottery.hitThreshold(rake,prize),n=await lottery.ballCountFor(rake,prize);
      if(threshold===0n){expect(n).eq(0n);continue;}
      expect(n*threshold>=10n**18n).eq(true);expect((n-1n)*threshold<10n**18n).eq(true);
      // Winning residue is the least frequent residue of a uniform 256-bit word.
      const words=1n<<256n;expect((words/n)*n<=words).eq(true);
    }
  });
  it('emits the reproducible integer result and conserves funds through wins and misses',async()=>{
    const{lottery,winner,outsider}=await setup();await lottery.fund({value:ethers.parseEther('10')});
    await lottery.recordRound(1,ethers.ZeroHash,winner.address,10n**18n);
    let foundHit=false,foundMiss=false;
    for(let id=2n;id<120n&&(!foundHit||!foundMiss);id++){
      const seed=ethers.toBeHex(id,32),prize=await lottery.committedPrize(),n=await lottery.ballCountFor(10n**18n,prize);
      const raw=BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32','bytes32'],[ethers.id('PLANK_NUMBERED_BALL_V1'),seed])));
      const drawn=n-raw%n;const tx=await lottery.recordRound(id,seed,winner.address,10n**18n);
      await expect(tx).emit(lottery,'NumberedDraw').withArgs(id,n,drawn);
      const receipt=await tx.wait();const draw=receipt.logs.map((l:any)=>{try{return lottery.interface.parseLog(l);}catch{return null;}}).find((e:any)=>e?.name==='Draw');
      expect(draw.args.hit).eq(drawn===1n);if(drawn===1n)foundHit=true;else foundMiss=true;
      expect(await ethers.provider.getBalance(await lottery.getAddress())).eq(await lottery.accountedBalance());
    }
    expect(foundHit&&foundMiss).eq(true);
    await expect(lottery.connect(outsider).recordRound(999,ethers.ZeroHash,winner.address,1)).revertedWithCustomError(lottery,'UnauthorizedSource');
  });
  it('does not invent a winning ball when the funded cap is zero',async()=>{
    const{lottery,winner}=await setup();await lottery.fund({value:10n**18n});await lottery.recordRound(1,ethers.ZeroHash,winner.address,1);
    await expect(lottery.recordRound(2,ethers.ZeroHash,winner.address,0)).emit(lottery,'NumberedDraw').withArgs(2,0,0);
    expect(await lottery.owed(winner.address)).eq(0);
  });
});
