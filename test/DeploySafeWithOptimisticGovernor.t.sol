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
        // remove matching owner (simple linear scan for mock)
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == owner) {
                owners[i] = owners[owners.length - 1];
                owners.pop();
                break;
            }
        }
        threshold = _threshold;
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
    ) external view returns (bytes32) {
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
        bytes calldata
    ) external payable returns (bool success) {
        if (operation != 0) {
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
    }

    function test_DeploysSafeAndOptimisticGovernor() public {
        script.run();

        address safeProxy = safeProxyFactory.lastProxy();
        assertTrue(safeProxy != address(0));

        SafeMock safe = SafeMock(safeProxy);
        assertEq(safe.owners(0), BURN_OWNER);
        assertEq(safe.threshold(), 1); // burn address set as sole owner
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
}
