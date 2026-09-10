// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract ExitReceiver {
    function execute(address target,bytes calldata data) external payable returns(bytes memory result){
        (bool ok,bytes memory value)=target.call{value:msg.value}(data);
        if(!ok)assembly {revert(add(value,32),mload(value))}
        return value;
    }
    receive() external payable {revert("cannot receive ETH");}
}
