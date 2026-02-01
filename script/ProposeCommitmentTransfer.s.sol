// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IOptimisticGovernor {
    struct Transaction {
        address to;
        uint8 operation;
        uint256 value;
        bytes data;
    }

    function proposeTransactions(Transaction[] calldata transactions) external returns (bytes32 proposalHash);

    function collateral() external view returns (address);

    function bondAmount() external view returns (uint256);

    function optimisticOracleV3() external view returns (address);
}

contract ProposeCommitmentTransfer is Script {
    uint8 internal constant OP_CALL = 0;

    function run() external {
        uint256 proposerPk = vm.envUint("PROPOSER_PK");
        address ogModule = vm.envAddress("OG_MODULE");
        address asset = vm.envAddress("TRANSFER_ASSET");
        address destination = vm.envAddress("TRANSFER_DESTINATION");
        uint256 amount = vm.envUint("TRANSFER_AMOUNT");
        uint8 operation = uint8(vm.envOr("TRANSFER_OPERATION", uint256(OP_CALL)));
        uint256 value = vm.envOr("TRANSFER_VALUE", uint256(0));

        bytes memory transferData = abi.encodeWithSignature("transfer(address,uint256)", destination, amount);

        IOptimisticGovernor.Transaction[] memory transactions = new IOptimisticGovernor.Transaction[](1);
        transactions[0] =
            IOptimisticGovernor.Transaction({to: asset, value: value, data: transferData, operation: operation});

        IOptimisticGovernor governor = IOptimisticGovernor(ogModule);
        address collateral = governor.collateral();
        uint256 bondAmount = governor.bondAmount();
        address optimisticOracle = governor.optimisticOracleV3();

        vm.startBroadcast(proposerPk);

        if (bondAmount > 0) {
            IERC20(collateral).approve(optimisticOracle, bondAmount);
        }

        bytes32 proposalHash = governor.proposeTransactions(transactions);

        vm.stopBroadcast();

        console2.log("Proposal hash:");
        console2.logBytes32(proposalHash);
    }
}
