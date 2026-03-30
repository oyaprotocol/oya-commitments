// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./SafeOwnerUtils.sol";

contract ManageSafeOwners is SafeOwnerUtils {
    function run() external returns (address safeProxy) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(deployerPk);
        safeProxy = vm.envAddress("COMMITMENT_SAFE");
        string memory action = vm.envOr("SAFE_OWNER_ACTION", string("set"));

        address[] memory desiredOwners = resolveDesiredOwners(action, safeProxy, deployer);

        return runWithDesiredOwners(deployerPk, safeProxy, action, desiredOwners);
    }

    function runWithDesiredOwners(
        uint256 deployerPk,
        address safeProxy,
        string memory action,
        address[] memory desiredOwners
    ) public returns (address) {
        vm.startBroadcast(deployerPk);
        reconcileOwners(deployerPk, safeProxy, desiredOwners);
        vm.stopBroadcast();

        logResult(safeProxy, action, desiredOwners);
        return safeProxy;
    }

    function resolveDesiredOwners(string memory action, address safeProxy, address deployer)
        internal
        view
        returns (address[] memory desiredOwners)
    {
        bytes32 actionHash = keccak256(bytes(action));
        if (actionHash == keccak256(bytes("set"))) {
            return loadRequestedOwners("SAFE_OWNERS", deployer);
        }
        if (actionHash == keccak256(bytes("add"))) {
            return mergeOwners(ISafe(safeProxy).getOwners(), loadExplicitOwners("SAFE_ADD_OWNERS"));
        }
        if (actionHash == keccak256(bytes("remove"))) {
            return subtractOwners(ISafe(safeProxy).getOwners(), loadExplicitOwners("SAFE_REMOVE_OWNERS"));
        }
        revert("unsupported owner action");
    }

    function mergeOwners(address[] memory currentOwners, address[] memory ownersToAdd)
        internal
        pure
        returns (address[] memory desiredOwners)
    {
        desiredOwners = new address[](currentOwners.length + ownersToAdd.length);
        uint256 nextIndex = 0;

        for (uint256 i = 0; i < currentOwners.length; i++) {
            desiredOwners[nextIndex++] = currentOwners[i];
        }

        for (uint256 i = 0; i < ownersToAdd.length; i++) {
            if (_containsOwner(currentOwners, ownersToAdd[i]) || _containsOwner(desiredOwners, ownersToAdd[i])) {
                continue;
            }
            desiredOwners[nextIndex++] = ownersToAdd[i];
        }

        assembly {
            mstore(desiredOwners, nextIndex)
        }
    }

    function subtractOwners(address[] memory currentOwners, address[] memory ownersToRemove)
        internal
        pure
        returns (address[] memory desiredOwners)
    {
        desiredOwners = new address[](currentOwners.length);
        uint256 nextIndex = 0;

        for (uint256 i = 0; i < ownersToRemove.length; i++) {
            require(_containsOwner(currentOwners, ownersToRemove[i]), "owner to remove not found");
        }

        for (uint256 i = 0; i < currentOwners.length; i++) {
            if (_containsOwner(ownersToRemove, currentOwners[i])) {
                continue;
            }
            desiredOwners[nextIndex++] = currentOwners[i];
        }

        if (nextIndex == 0) {
            desiredOwners = new address[](1);
            desiredOwners[0] = BURN_OWNER;
            return desiredOwners;
        }

        assembly {
            mstore(desiredOwners, nextIndex)
        }
    }

    function logResult(address safeProxy, string memory action, address[] memory owners) internal pure {
        console2.log("=== Safe Owner Update ===");
        console2.log("Safe:", safeProxy);
        console2.log("Action:", action);
        console2.log("Owners:");
        for (uint256 i = 0; i < owners.length; i++) {
            console2.logAddress(owners[i]);
        }
        console2.log("Threshold:");
        console2.logUint(owners.length);
    }
}
