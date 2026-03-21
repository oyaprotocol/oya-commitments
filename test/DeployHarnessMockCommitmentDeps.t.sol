// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../script/DeployHarnessMockCommitmentDeps.s.sol";

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
}
