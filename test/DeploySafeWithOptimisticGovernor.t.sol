// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../script/DeploySafeWithOptimisticGovernor.s.sol";

contract SafeMock {
    address[] public owners;
    uint256 public threshold;
    address public fallbackHandler;
    uint256 public nonce;
    address public lastEnabledModule;
    mapping(address => bool) public modules;

    function setup(
        address[] calldata _owners,
        uint256 _threshold,
        address,
        bytes calldata,
        address _fallbackHandler,
        address,
        uint256,
        address payable
    ) external {
        owners = _owners;
        threshold = _threshold;
        fallbackHandler = _fallbackHandler;
    }

    function enableModule(address module) external {
        modules[module] = true;
        lastEnabledModule = module;
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

    function isModuleEnabled(address module) external view returns (bool) {
        return modules[module];
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

contract SafeProxyFactoryMock {
    address public lastProxy;

    function createProxyWithNonce(address, bytes memory initializer, uint256) external returns (address proxy) {
        SafeMock safe = new SafeMock();
        (bool success,) = address(safe).call(initializer);
        require(success, "setup failed");
        lastProxy = address(safe);
        return lastProxy;
    }
}

contract OptimisticGovernorMock {
    address public owner;
    address public collateral;
    uint256 public bondAmount;
    string public rules;
    bytes32 public identifier;
    uint64 public liveness;

    function setUp(bytes memory data) external {
        (owner, collateral, bondAmount, rules, identifier, liveness) =
            abi.decode(data, (address, address, uint256, string, bytes32, uint64));
    }
}

contract DeploySafeWithOptimisticGovernorTest is Test {
    address internal constant BURN_OWNER = 0x000000000000000000000000000000000000dEaD;
    address internal constant DEPLOYER = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf;
    address internal constant OWNER_A = 0x1111111111111111111111111111111111111111;
    address internal constant OWNER_B = 0x2222222222222222222222222222222222222222;

    SafeProxyFactoryMock private safeProxyFactory;
    OptimisticGovernorMock private ogMasterCopy;
    ModuleProxyFactory private moduleProxyFactory;
    DeploySafeWithOptimisticGovernor private script;

    function setUp() public {
        safeProxyFactory = new SafeProxyFactoryMock();
        ogMasterCopy = new OptimisticGovernorMock();
        moduleProxyFactory = new ModuleProxyFactory();
        script = new DeploySafeWithOptimisticGovernor();

        vm.setEnv("DEPLOYER_PK", "1");
        vm.setEnv("SAFE_PROXY_FACTORY", vm.toString(address(safeProxyFactory)));
        vm.setEnv("SAFE_SINGLETON", vm.toString(address(0xBEEF)));
        vm.setEnv("SAFE_FALLBACK_HANDLER", vm.toString(address(0xFA11)));
        vm.setEnv("OG_MASTER_COPY", vm.toString(address(ogMasterCopy)));
        vm.setEnv("MODULE_PROXY_FACTORY", vm.toString(address(moduleProxyFactory)));

        vm.setEnv("OG_COLLATERAL", vm.toString(address(0xCA11)));
        vm.setEnv("OG_BOND_AMOUNT", vm.toString(uint256(250_000_000)));
        vm.setEnv(
            "OG_RULES",
            "Any assets deposited in this Commitment may be transferred back to the depositor before January 15th, 2026 (12:00AM PST). After the deadline, assets may only be transferred to jdshutt.eth. If a third party is initiating the transfer after the deadline, they may take a 10% cut of the assets being transferred as a fee."
        );
        vm.setEnv("OG_LIVENESS", vm.toString(uint256(3600)));
        vm.setEnv("OG_IDENTIFIER_STR", "COMMITMENT");
        vm.setEnv("SAFE_OWNERS", vm.toString(DEPLOYER));
    }

    function test_DeploysSafeAndOptimisticGovernorWithDeployerOwner() public {
        script.run();

        address safeProxy = safeProxyFactory.lastProxy();
        assertTrue(safeProxy != address(0));

        SafeMock safe = SafeMock(safeProxy);
        address[] memory owners = safe.getOwners();
        assertEq(owners.length, 1);
        assertEq(owners[0], DEPLOYER);
        assertEq(safe.getThreshold(), 1);
        assertEq(safe.fallbackHandler(), address(0xFA11));

        address module = safe.lastEnabledModule();
        assertTrue(safe.isModuleEnabled(module));

        OptimisticGovernorMock og = OptimisticGovernorMock(module);
        assertEq(og.owner(), safeProxy);
        assertEq(og.collateral(), address(0xCA11));
        assertEq(og.bondAmount(), 250_000_000);
        assertEq(
            og.rules(),
            "Any assets deposited in this Commitment may be transferred back to the depositor before January 15th, 2026 (12:00AM PST). After the deadline, assets may only be transferred to jdshutt.eth. If a third party is initiating the transfer after the deadline, they may take a 10% cut of the assets being transferred as a fee."
        );
        assertEq(og.identifier(), bytes32(bytes("COMMITMENT")));
        assertEq(og.liveness(), uint64(3600));
    }

    function test_DeploysSafeWithBurnOwnerWhenRequested() public {
        vm.setEnv("SAFE_OWNERS", "0x");

        script.run();

        SafeMock safe = SafeMock(safeProxyFactory.lastProxy());
        address[] memory owners = safe.getOwners();
        assertEq(owners.length, 1);
        assertEq(owners[0], BURN_OWNER);
        assertEq(safe.getThreshold(), 1);
    }

    function test_DeploysSafeWithExplicitUnanimousOwners() public {
        vm.setEnv("SAFE_OWNERS", string.concat(vm.toString(OWNER_A), ",", vm.toString(OWNER_B)));

        script.run();

        SafeMock safe = SafeMock(safeProxyFactory.lastProxy());
        address[] memory owners = safe.getOwners();
        assertEq(owners.length, 2);
        assertEq(owners[0], OWNER_A);
        assertEq(owners[1], OWNER_B);
        assertEq(safe.getThreshold(), 2);
    }

    function test_DeploysSafeWhenDeployerIsSpecifiedMidList() public {
        vm.setEnv("SAFE_OWNERS", string.concat(vm.toString(OWNER_A), ",", vm.toString(DEPLOYER), ",", vm.toString(OWNER_B)));

        script.run();

        SafeMock safe = SafeMock(safeProxyFactory.lastProxy());
        address[] memory owners = safe.getOwners();
        assertEq(owners.length, 3);
        assertTrue(_containsOwner(owners, OWNER_A));
        assertTrue(_containsOwner(owners, DEPLOYER));
        assertTrue(_containsOwner(owners, OWNER_B));
        assertEq(safe.getThreshold(), 3);
    }

    function _containsOwner(address[] memory owners, address candidate) internal pure returns (bool) {
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == candidate) {
                return true;
            }
        }
        return false;
    }
}
