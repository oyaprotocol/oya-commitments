// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";

interface ISafe {
    function setup(
        address[] calldata _owners,
        uint256 _threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;

    function nonce() external view returns (uint256);

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 _nonce
    ) external view returns (bytes32);

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures
    ) external payable returns (bool success);

    function addOwnerWithThreshold(address owner, uint256 _threshold) external;

    function removeOwner(address prevOwner, address owner, uint256 _threshold) external;

    function changeThreshold(uint256 _threshold) external;

    function getOwners() external view returns (address[] memory);

    function getThreshold() external view returns (uint256);
}

abstract contract SafeOwnerUtils is Script {
    uint8 internal constant OP_CALL = 0;
    address internal constant BURN_OWNER = 0x000000000000000000000000000000000000dEaD;
    address internal constant SENTINEL_OWNERS = 0x0000000000000000000000000000000000000001;

    function loadRequestedOwners(string memory envKey, address defaultOwner)
        internal
        view
        returns (address[] memory owners)
    {
        string memory rawOwners = vm.envOr(envKey, string(""));
        if (bytes(rawOwners).length == 0) {
            owners = new address[](1);
            owners[0] = defaultOwner;
            return owners;
        }
        if (_isBurnOwnerSentinel(rawOwners)) {
            owners = new address[](1);
            owners[0] = BURN_OWNER;
            return owners;
        }

        owners = vm.envAddress(envKey, ",");
        _validateOwnerList(owners, false);
    }

    function loadExplicitOwners(string memory envKey) internal view returns (address[] memory owners) {
        string memory rawOwners = vm.envOr(envKey, string(""));
        require(bytes(rawOwners).length != 0, "owner list is required");
        require(!_isBurnOwnerSentinel(rawOwners), "use set owners with 0x to burn ownership");

        owners = vm.envAddress(envKey, ",");
        _validateOwnerList(owners, false);
    }

    function reconcileOwners(uint256 signerPk, address safeProxy, address[] memory desiredOwners) internal {
        _validateOwnerList(desiredOwners, true);

        ISafe safe = ISafe(safeProxy);
        require(safe.getThreshold() == 1, "safe threshold must be 1");

        address signer = vm.addr(signerPk);
        address[] memory currentOwners = safe.getOwners();
        require(_containsOwner(currentOwners, signer), "signer must be a safe owner");

        for (uint256 i = 0; i < desiredOwners.length; i++) {
            address owner = desiredOwners[i];
            if (_containsOwner(currentOwners, owner)) {
                continue;
            }
            _execSafeTransaction(
                signerPk, safeProxy, abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", owner, 1)
            );
            currentOwners = safe.getOwners();
        }

        while (true) {
            bool removedOwner = false;
            for (uint256 i = 0; i < currentOwners.length; i++) {
                address owner = currentOwners[i];
                if (_containsOwner(desiredOwners, owner)) {
                    continue;
                }
                address prevOwner = _findPreviousOwner(currentOwners, owner);
                _execSafeTransaction(
                    signerPk,
                    safeProxy,
                    abi.encodeWithSignature("removeOwner(address,address,uint256)", prevOwner, owner, 1)
                );
                currentOwners = safe.getOwners();
                removedOwner = true;
                break;
            }
            if (!removedOwner) {
                break;
            }
        }

        if (desiredOwners.length > 1) {
            _execSafeTransaction(
                signerPk, safeProxy, abi.encodeWithSignature("changeThreshold(uint256)", desiredOwners.length)
            );
        }

        currentOwners = safe.getOwners();
        require(currentOwners.length == desiredOwners.length, "owner count mismatch");
        require(safe.getThreshold() == desiredOwners.length, "threshold mismatch");
        for (uint256 i = 0; i < desiredOwners.length; i++) {
            require(_containsOwner(currentOwners, desiredOwners[i]), "missing desired owner");
        }
    }

    function _execSafeTransaction(uint256 signerPk, address safeProxy, bytes memory data) internal {
        ISafe safe = ISafe(safeProxy);
        bytes32 txHash =
            safe.getTransactionHash(safeProxy, 0, data, OP_CALL, 0, 0, 0, address(0), address(0), safe.nonce());

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, txHash);
        bytes memory sig = abi.encodePacked(r, s, v);

        bool ok = safe.execTransaction(safeProxy, 0, data, OP_CALL, 0, 0, 0, address(0), payable(address(0)), sig);
        require(ok, "safe execTransaction failed");
    }

    function _findPreviousOwner(address[] memory owners, address owner) internal pure returns (address prevOwner) {
        prevOwner = SENTINEL_OWNERS;
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == owner) {
                return prevOwner;
            }
            prevOwner = owners[i];
        }
        revert("owner not found");
    }

    function _containsOwner(address[] memory owners, address owner) internal pure returns (bool) {
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == owner) {
                return true;
            }
        }
        return false;
    }

    function _validateOwnerList(address[] memory owners, bool allowBurnOwner) internal pure {
        require(owners.length > 0, "at least one owner is required");
        for (uint256 i = 0; i < owners.length; i++) {
            address owner = owners[i];
            require(owner != address(0), "owner cannot be zero address");
            require(owner != SENTINEL_OWNERS, "owner cannot be sentinel");
            if (!allowBurnOwner) {
                require(owner != BURN_OWNER, "use 0x to burn ownership");
            }
            for (uint256 j = i + 1; j < owners.length; j++) {
                require(owner != owners[j], "duplicate owner");
            }
        }
    }

    function _isBurnOwnerSentinel(string memory rawValue) internal pure returns (bool) {
        bytes memory value = bytes(rawValue);
        return value.length == 2 && value[0] == bytes1(0x30) && value[1] == bytes1(0x78);
    }
}
