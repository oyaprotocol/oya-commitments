// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../script/ManageSafeOwners.s.sol";

contract ManagedSafeMock {
    address[] public owners;
    uint256 public threshold;
    uint256 public nonce;

    function setupOwners(address[] memory initialOwners, uint256 initialThreshold) external {
        owners = initialOwners;
        threshold = initialThreshold;
    }

    function addOwnerWithThreshold(address owner, uint256 _threshold) external {
        owners.push(owner);
        threshold = _threshold;
    }

    function removeOwner(address, address owner, uint256 _threshold) external {
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == owner) {
                for (uint256 j = i; j + 1 < owners.length; j++) {
                    owners[j] = owners[j + 1];
                }
                owners.pop();
                break;
            }
        }
        threshold = _threshold;
    }

    function changeThreshold(uint256 _threshold) external {
        threshold = _threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function getTransactionHash(
        address,
        uint256,
        bytes calldata,
        uint8,
        uint256,
        uint256,
        uint256,
        address,
        address,
        uint256 _nonce
    ) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(_nonce));
    }

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256,
        uint256,
        uint256,
        address,
        address payable,
        bytes calldata signatures
    ) external payable returns (bool success) {
        if (operation != 0 || threshold != 1) {
            return false;
        }
        bytes32 txHash = keccak256(abi.encodePacked(nonce));
        address signer = _recoverSigner(txHash, signatures);
        if (!_isOwner(signer)) {
            return false;
        }
        (success,) = to.call{value: value}(data);
        if (success) {
            nonce += 1;
        }
    }

    function _isOwner(address candidate) internal view returns (bool) {
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == candidate) {
                return true;
            }
        }
        return false;
    }

    function _recoverSigner(bytes32 txHash, bytes calldata signatures) internal pure returns (address signer) {
        if (signatures.length != 65) {
            return address(0);
        }

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signatures.offset)
            s := calldataload(add(signatures.offset, 0x20))
            v := byte(0, calldataload(add(signatures.offset, 0x40)))
        }
        signer = ecrecover(txHash, v, r, s);
    }
}

contract ManageSafeOwnersTest is Test {
    address internal constant BURN_OWNER = 0x000000000000000000000000000000000000dEaD;
    address internal constant DEPLOYER = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf;
    address internal constant OWNER_A = 0x1111111111111111111111111111111111111111;
    address internal constant OWNER_B = 0x2222222222222222222222222222222222222222;
    address internal constant OWNER_C = 0x3333333333333333333333333333333333333333;

    ManageSafeOwners private script;
    ManagedSafeMock private safe;

    function setUp() public {
        script = new ManageSafeOwners();
        safe = new ManagedSafeMock();

        vm.setEnv("DEPLOYER_PK", "1");
        vm.setEnv("COMMITMENT_SAFE", vm.toString(address(safe)));
        vm.setEnv("SAFE_OWNER_ACTION", "set");
        vm.setEnv("SAFE_OWNERS", vm.toString(DEPLOYER));
        vm.setEnv("SAFE_ADD_OWNERS", vm.toString(OWNER_C));
        vm.setEnv("SAFE_REMOVE_OWNERS", vm.toString(OWNER_C));
    }

    function test_AddOwnersBuildsUnanimousOwnerSet() public {
        _setupOwners(_singleOwner(DEPLOYER), 1);
        vm.setEnv("SAFE_OWNER_ACTION", "add");
        vm.setEnv("SAFE_ADD_OWNERS", string.concat(vm.toString(OWNER_A), ",", vm.toString(OWNER_B)));

        script.run();

        address[] memory owners = new address[](3);
        owners[0] = DEPLOYER;
        owners[1] = OWNER_A;
        owners[2] = OWNER_B;
        _assertOwners(owners, 3);
    }

    function test_RemoveOwnersReconcilesToRemainingOwners() public {
        address[] memory owners = new address[](3);
        owners[0] = DEPLOYER;
        owners[1] = OWNER_A;
        owners[2] = OWNER_B;
        _setupOwners(owners, 1);
        vm.setEnv("SAFE_OWNER_ACTION", "remove");
        vm.setEnv("SAFE_REMOVE_OWNERS", string.concat(vm.toString(OWNER_A), ",", vm.toString(OWNER_B)));

        script.run();

        _assertOwners(_singleOwner(DEPLOYER), 1);
    }

    function test_RemoveOwnersFallsBackToBurnOwnerWhenEmpty() public {
        address[] memory owners = new address[](2);
        owners[0] = DEPLOYER;
        owners[1] = OWNER_C;
        _setupOwners(owners, 1);
        vm.setEnv("SAFE_OWNER_ACTION", "remove");
        vm.setEnv("SAFE_REMOVE_OWNERS", string.concat(vm.toString(DEPLOYER), ",", vm.toString(OWNER_C)));

        script.run();

        _assertOwners(_singleOwner(BURN_OWNER), 1);
    }

    function test_RemoveOwnersRemovesSignerLast() public {
        address[] memory owners = new address[](3);
        owners[0] = DEPLOYER;
        owners[1] = OWNER_A;
        owners[2] = OWNER_B;
        _setupOwners(owners, 1);
        vm.setEnv("SAFE_OWNER_ACTION", "remove");
        vm.setEnv("SAFE_REMOVE_OWNERS", string.concat(vm.toString(DEPLOYER), ",", vm.toString(OWNER_B)));

        script.run();

        _assertOwners(_singleOwner(OWNER_A), 1);
    }

    function _setupOwners(address[] memory owners, uint256 currentThreshold) internal {
        safe.setupOwners(owners, currentThreshold);
    }

    function _singleOwner(address owner) internal pure returns (address[] memory owners) {
        owners = new address[](1);
        owners[0] = owner;
    }

    function _assertOwners(address[] memory expectedOwners, uint256 expectedThreshold) internal view {
        address[] memory owners = safe.getOwners();
        assertEq(owners.length, expectedOwners.length);
        for (uint256 i = 0; i < owners.length; i++) {
            assertEq(owners[i], expectedOwners[i]);
        }
        assertEq(safe.getThreshold(), expectedThreshold);
    }
}
