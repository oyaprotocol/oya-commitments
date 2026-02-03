// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "./mocks/MockERC20.sol";
import "./mocks/MockOptimisticOracleV3.sol";

contract OptimisticOracleV3DisputeTest is Test {
    MockERC20 private token;
    MockOptimisticOracleV3 private oracle;
    address private disputer;

    function setUp() public {
        token = new MockERC20("Bond", "BOND", 18);
        oracle = new MockOptimisticOracleV3();
        disputer = address(0xB00D);
        token.mint(disputer, 1_000 ether);
    }

    function test_DisputeRequiresBondApproval() public {
        bytes32 assertionId = keccak256("assertion");

        MockOptimisticOracleV3.Assertion memory assertion = MockOptimisticOracleV3.Assertion({
            escalationManagerSettings: MockOptimisticOracleV3.EscalationManagerSettings({
                arbitrateViaEscalationManager: false,
                discardOracle: false,
                validateDisputers: false,
                assertingCaller: address(0),
                escalationManager: address(0)
            }),
            asserter: address(0xA11CE),
            assertionTime: uint64(block.timestamp),
            settled: false,
            currency: token,
            expirationTime: uint64(block.timestamp + 1 days),
            settlementResolution: false,
            domainId: bytes32(0),
            identifier: bytes32("ASSERT_TRUTH"),
            bond: 100 ether,
            callbackRecipient: address(0),
            disputer: address(0)
        });

        oracle.setAssertion(assertionId, assertion);

        vm.startPrank(disputer);
        vm.expectRevert("allowance");
        oracle.disputeAssertion(assertionId, disputer);

        token.approve(address(oracle), 100 ether);
        oracle.disputeAssertion(assertionId, disputer);
        vm.stopPrank();

        MockOptimisticOracleV3.Assertion memory updated = oracle.getAssertion(assertionId);
        assertEq(updated.disputer, disputer);
    }
}
