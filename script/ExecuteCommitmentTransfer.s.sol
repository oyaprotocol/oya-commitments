// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";

interface IOptimisticGovernorExecute {
    struct Transaction {
        address to;
        uint256 value;
        bytes data;
        uint8 operation;
    }

    function executeProposal(bytes32 proposalHash, Transaction[] calldata transactions) external;
}

contract ExecuteCommitmentTransfer is Script {
    uint8 internal constant OP_CALL = 0;

    function run() external {
        uint256 executorPk = vm.envUint("EXECUTOR_PK");
        address ogModule = vm.envAddress("OG_MODULE");
        bytes32 proposalHash = vm.envBytes32("PROPOSAL_HASH");
        address asset = vm.envAddress("TRANSFER_ASSET");
        address destination = vm.envAddress("TRANSFER_DESTINATION");
        uint256 amount = vm.envUint("TRANSFER_AMOUNT");
        uint8 operation = uint8(vm.envOr("TRANSFER_OPERATION", uint256(OP_CALL)));
        uint256 value = vm.envOr("TRANSFER_VALUE", uint256(0));

        bytes memory transferData = abi.encodeWithSignature("transfer(address,uint256)", destination, amount);

        IOptimisticGovernorExecute.Transaction[] memory transactions = new IOptimisticGovernorExecute.Transaction[](1);
        transactions[0] =
            IOptimisticGovernorExecute.Transaction({to: asset, value: value, data: transferData, operation: operation});

        vm.startBroadcast(executorPk);

        IOptimisticGovernorExecute(ogModule).executeProposal(proposalHash, transactions);

        vm.stopBroadcast();
    }
}
