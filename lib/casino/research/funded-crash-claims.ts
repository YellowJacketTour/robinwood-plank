/** Research prototype, NOT wired to a deployment or game UI.
 * Fixed claims separate payout entitlement from the other players' decisions.
 * Exact maximum liability is reserved before accepting a commitment.
 */
export const BPS=10_000n;
export type Budget={assets:bigint;protectedVault:bigint;protectedLottery:bigint;fees:bigint;owed:bigint;reservedClaims:bigint};
export type Claim={stake:bigint;targetBps:bigint;payout:bigint};
export function freeCollateral(b:Budget){return b.assets-b.protectedVault-b.protectedLottery-b.fees-b.owed-b.reservedClaims;}
export function quoteClaim(stake:bigint,targetBps:bigint,clearingBps:bigint=10_000n):Claim{
 if(stake<=0n||targetBps<10_100n||targetBps>100_000_000n||clearingBps<=0n||clearingBps>BPS)throw new RangeError('Invalid fixed claim');
 return {stake,targetBps,payout:stake*targetBps*clearingBps/(BPS*BPS)};
}
export function acceptClaim(b:Budget,c:Claim,feeBps:bigint):Budget{
 if(c.stake<=0n||c.targetBps<10100n||c.payout<0n||c.payout>c.stake*c.targetBps/BPS||Object.values(b).some(v=>v<0n)||feeBps<0n||feeBps>BPS||freeCollateral(b)<0n)throw new RangeError('Invalid funded budget');
 const next={...b,assets:b.assets+c.stake,fees:b.fees+c.stake*feeBps/BPS,reservedClaims:b.reservedClaims+c.payout};
 if(freeCollateral(next)<0n)throw new RangeError('Insufficient unencumbered collateral');
 return next;
}
export function settleClaims(b:Budget,claims:Claim[],crashBps:bigint):Budget{
 const maximum=claims.reduce((s,c)=>s+c.payout,0n),paid=claims.reduce((s,c)=>s+(crashBps>=c.targetBps?c.payout:0n),0n);
 if(maximum>b.reservedClaims)throw new RangeError('Unreserved claims');
 return {...b,reservedClaims:b.reservedClaims-maximum,owed:b.owed+paid};
}
/** Exact discrete survival mass; edge is committed before bets and entropy.
 * edgeBps=0 reproduces the existing 10000-residue law for accepted targets.
 * With edge>0, targets with zero surviving residues must be rejected by admission.
 */
export function winningResidues(targetBps:bigint,edgeBps:bigint=0n):bigint{
 if(targetBps<10_100n||edgeBps<0n||edgeBps>=BPS)throw new RangeError('Invalid crash law');
 const n=(BPS-edgeBps)*BPS/targetBps;return n>9999n?9999n:n;
}
