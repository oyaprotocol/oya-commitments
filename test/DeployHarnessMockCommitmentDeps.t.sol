// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../script/DeployHarnessMockCommitmentDeps.s.sol";

contract SenderRecorder {
    address public lastSender;

    function recordSender() external {
        lastSender = msg.sender;
    }
}

contract DeployHarnessMockCommitmentDepsTest is Test {
    function test_MockSafeProxyFactoryRejectsUnexpectedSingleton() public {
        HarnessMockSafe singleton = new HarnessMockSafe();
        HarnessMockSafeProxyFactory factory = new HarnessMockSafeProxyFactory(address(singleton));

        address[] memory owners = new address[](1);
        owners[0] = address(this);
        bytes memory initializer = abi.encodeWithSelector(
            HarnessMockSafe.setup.selector,
            owners,
            1,
            address(0),
            bytes(""),
            address(0),
            address(0),
            0,
            payable(address(0))
        );

        vm.expectRevert("invalid singleton");
        factory.createProxyWithNonce(address(0xBEEF), initializer, 1);
    }

    function test_ExecuteProposalRoutesCallsThroughSafe() public {
        HarnessMockSafe safe = new HarnessMockSafe();
        HarnessMockOptimisticGovernor og = new HarnessMockOptimisticGovernor();
        SenderRecorder recorder = new SenderRecorder();

        address[] memory owners = new address[](1);
        owners[0] = address(this);
        safe.setup(owners, 1, address(0), bytes(""), address(0), address(0), 0, payable(address(0)));
        safe.enableModule(address(og));

        og.setUp(abi.encode(address(safe), address(0xCA11), uint256(1), "rules", bytes32("COMMITMENT"), uint64(3600)));

        HarnessMockOptimisticGovernor.Transaction[] memory transactions =
            new HarnessMockOptimisticGovernor.Transaction[](1);
        transactions[0] = HarnessMockOptimisticGovernor.Transaction({
            to: address(recorder),
            operation: 0,
            value: 0,
            data: abi.encodeWithSelector(SenderRecorder.recordSender.selector)
        });

        og.proposeTransactions(transactions, bytes("local-mock execution test"));
        og.executeProposal(transactions);

        assertEq(recorder.lastSender(), address(safe));
    }
}
