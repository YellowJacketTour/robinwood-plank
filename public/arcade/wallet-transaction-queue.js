// Serialize sends from the same raw-key wallet, including background claims.
// Allocate a fresh pending nonce only inside the lock; failed estimates leave no gap.
export function queueWalletTransactions(wallet, provider, locks = globalThis.navigator?.locks) {
  const original=wallet.sendTransaction.bind(wallet);
  let tail=Promise.resolve();
  wallet.sendTransaction=request=>{
    const execute=async()=>{
      const network=await provider.getNetwork();
      const send=async()=>{
        const nonce=request.nonce ?? BigInt(await provider.send('eth_getTransactionCount',[wallet.address,'pending']));
        const transaction=await original({...request,nonce});
        await transaction.wait();
        return transaction;
      };
      return locks ? locks.request(`plank-wallet:${network.chainId}:${wallet.address.toLowerCase()}`,send) : send();
    };
    const result=tail.then(execute,execute);tail=result.catch(()=>{});return result;
  };
  return wallet;
}
