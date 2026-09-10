import {expect} from 'chai';
import {ethers} from './helpers/hardhat.js';
describe('Community fuel candidate',()=>{
  async function setup(){
    const [player,other]=await ethers.getSigners();
    const token=await(await ethers.getContractFactory('MockERC20Burnable')).deploy();
    const sink=await(await ethers.getContractFactory('FuelDestinationMock')).deploy();
    const fuel=await(await ethers.getContractFactory('PlankCommunityFuel')).deploy(await token.getAddress(),await sink.getAddress(),10n**12n,2n*10n**12n);
    for(const who of [player,other]){await token.mint(who.address,10n**20n);await token.connect(who).approve(await fuel.getAddress(),10n**20n);}
    await fuel.fund({value:10n**15n});
    return{player,other,token,sink,fuel};
  }
  it('burns exactly the approved amount and delivers only pre-funded ETH',async()=>{
    const{player,token,sink,fuel}=await setup();const before=await token.balanceOf(player.address);
    await fuel.burnFuel(10n**18n,1,10n**12n,2n**64n-1n);
    expect(await token.balanceOf(player.address)).eq(before-10n**18n);
    expect(await sink.received()).eq(10n**12n);
    expect(await ethers.provider.getBalance(await fuel.getAddress())).eq(await fuel.backing());
  });
  it('rejects stale rounds, expired deadlines, zero output and slippage before burning',async()=>{
    const{player,token,fuel}=await setup();const before=await token.balanceOf(player.address);
    await expect(fuel.burnFuel(10n**18n,2,1,2n**64n-1n)).revertedWithCustomError(fuel,'WrongRound');
    await expect(fuel.burnFuel(10n**18n,1,1,0)).revertedWithCustomError(fuel,'QuoteExpired');
    await expect(fuel.burnFuel(1,1,1,2n**64n-1n)).revertedWithCustomError(fuel,'UnfundedQuote');
    await expect(fuel.burnFuel(10n**18n,1,2n*10n**12n,2n**64n-1n)).revertedWithCustomError(fuel,'UnfundedQuote');
    expect(await token.balanceOf(player.address)).eq(before);
  });
  it('shares one round cap across wallets and atomically rolls back a rejected destination',async()=>{
    const{player,other,token,sink,fuel}=await setup();
    await fuel.burnFuel(2n*10n**18n,1,1,2n**64n-1n);
    await expect(fuel.connect(other).burnFuel(10n**18n,1,1,2n**64n-1n)).revertedWithCustomError(fuel,'UnfundedQuote');
    await sink.configure(2,0,2n**64n-1n,true);
    const before=await token.balanceOf(player.address),backing=await fuel.backing();
    await expect(fuel.burnFuel(10n**18n,2,1,2n**64n-1n)).revertedWith('sink rejected');
    expect(await token.balanceOf(player.address)).eq(before);expect(await fuel.backing()).eq(backing);expect(await fuel.usedInRound(2)).eq(0);
  });
  it('cannot burn after betting closes',async()=>{
    const{sink,fuel}=await setup();await sink.configure(1,1,2n**64n-1n,false);
    await expect(fuel.burnFuel(10n**18n,1,1,2n**64n-1n)).revertedWithCustomError(fuel,'BettingClosed');
  });
});
