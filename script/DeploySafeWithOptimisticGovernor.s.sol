// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./SafeOwnerUtils.sol";

/// ------------------------
/// Minimal interfaces
/// ------------------------

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface IModuleProxyFactory {
    function deployModule(address masterCopy, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/// ------------------------
/// Zodiac ModuleProxyFactory (tiny, self-contained)
/// Matches the deployModule pattern (CREATE2 + initializer call). :contentReference[oaicite:8]{index=8}
/// ------------------------
contract ModuleProxyFactory {
    event ModuleProxyCreation(address indexed proxy, address indexed masterCopy);

    error ZeroAddress(address target);
    error TakenAddress(address address_);
    error FailedInitialization();

    function createProxy(address target, bytes32 salt) internal returns (address result) {
        if (target == address(0)) revert ZeroAddress(target);
        bytes memory deployment =
            abi.encodePacked(hex"602d8060093d393df3363d3d373d3d3d363d73", target, hex"5af43d82803e903d91602b57fd5bf3");
        assembly {
            result := create2(0, add(deployment, 0x20), mload(deployment), salt)
        }
        if (result == address(0)) revert TakenAddress(result);
    }

    function deployModule(address masterCopy, bytes memory initializer, uint256 saltNonce)
        public
        returns (address proxy)
    {
        proxy = createProxy(masterCopy, keccak256(abi.encodePacked(keccak256(initializer), saltNonce)));
        (bool success,) = proxy.call(initializer);
        if (!success) revert FailedInitialization();
        emit ModuleProxyCreation(proxy, masterCopy);
    }
}

contract DeploySafeWithOptimisticGovernor is SafeOwnerUtils {
    struct Config {
        address safeSingleton;
        address safeProxyFactory;
        address safeFallbackHandler;
        address moduleProxyFactory;
        address ogMasterCopy;
        address collateral;
        uint256 bondAmount;
        uint64 liveness;
        bytes32 identifier;
        uint256 safeSaltNonce;
        uint256 ogSaltNonce;
    }

    function run()
        external
        returns (address deployedModuleProxyFactory, address deployedSafe, address deployedOgModule)
    {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(deployerPk);
        address[] memory requestedOwners = loadRequestedOwners("SAFE_OWNERS", deployer);
        Config memory config = loadConfig();
        string memory rules = vm.envString("OG_RULES");

        return runWithConfig(deployerPk, requestedOwners, config, rules);
    }

    function runWithConfig(
        uint256 deployerPk,
        address[] memory requestedOwners,
        Config memory config,
        string memory rules
    ) public returns (address deployedModuleProxyFactory, address deployedSafe, address deployedOgModule) {
        address deployer = vm.addr(deployerPk);
        address[] memory bootstrapOwners = new address[](1);
        bootstrapOwners[0] = deployer;

        vm.startBroadcast(deployerPk);

        address moduleProxyFactory = resolveModuleProxyFactory(config.moduleProxyFactory);
        address safeProxy = deploySafeProxy(config, bootstrapOwners, 1);
        address ogModule = deployOptimisticGovernor(config, moduleProxyFactory, safeProxy, rules);

        enableModule(deployerPk, safeProxy, ogModule);
        reconcileOwners(deployerPk, safeProxy, requestedOwners);

        vm.stopBroadcast();

        logDeployment(moduleProxyFactory, safeProxy, ogModule, config, requestedOwners);

        return (moduleProxyFactory, safeProxy, ogModule);
    }

    function loadConfig() internal view returns (Config memory config) {
        config.safeSingleton = vm.envOr("SAFE_SINGLETON", address(0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552));

        config.safeProxyFactory = vm.envOr("SAFE_PROXY_FACTORY", address(0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2));

        config.safeFallbackHandler =
            vm.envOr("SAFE_FALLBACK_HANDLER", address(0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4));

        config.moduleProxyFactory = vm.envOr("MODULE_PROXY_FACTORY", address(0));
        config.ogMasterCopy = vm.envOr("OG_MASTER_COPY", address(0x28CeBFE94a03DbCA9d17143e9d2Bd1155DC26D5d));

        config.collateral = vm.envAddress("OG_COLLATERAL");
        config.bondAmount = vm.envUint("OG_BOND_AMOUNT");
        config.liveness = uint64(vm.envOr("OG_LIVENESS", uint256(2 days)));

        string memory identifierStr = vm.envOr("OG_IDENTIFIER_STR", defaultIdentifierStr());
        config.identifier = bytes32(bytes(identifierStr));

        config.safeSaltNonce = vm.envOr("SAFE_SALT_NONCE", uint256(1));
        config.ogSaltNonce = vm.envOr("OG_SALT_NONCE", uint256(1));
    }

    function defaultIdentifierStr() internal view returns (string memory) {
        if (block.chainid == 11155111) {
            return "ASSERT_TRUTH";
        }
        return "ASSERT_TRUTH2";
    }

    function resolveModuleProxyFactory(address moduleProxyFactory) internal returns (address) {
        if (moduleProxyFactory == address(0)) {
            ModuleProxyFactory mpf = new ModuleProxyFactory();
            moduleProxyFactory = address(mpf);
        }
        return moduleProxyFactory;
    }

    function deploySafeProxy(Config memory config, address[] memory owners, uint256 threshold)
        internal
        returns (address safeProxy)
    {
        bytes memory safeInitializer = abi.encodeWithSelector(
            ISafe.setup.selector,
            owners,
            threshold,
            address(0),
            bytes(""),
            config.safeFallbackHandler,
            address(0),
            0,
            payable(address(0))
        );

        safeProxy = ISafeProxyFactory(config.safeProxyFactory)
            .createProxyWithNonce(config.safeSingleton, safeInitializer, config.safeSaltNonce);
    }

    function deployOptimisticGovernor(
        Config memory config,
        address moduleProxyFactory,
        address safeProxy,
        string memory rules
    ) internal returns (address ogModule) {
        bytes memory ogInitParams = abi.encode(
            safeProxy, config.collateral, config.bondAmount, rules, config.identifier, config.liveness
        );

        bytes memory ogInitializerCall = abi.encodeWithSignature("setUp(bytes)", ogInitParams);

        ogModule = IModuleProxyFactory(moduleProxyFactory)
            .deployModule(config.ogMasterCopy, ogInitializerCall, config.ogSaltNonce);
    }

    function enableModule(uint256 deployerPk, address safeProxy, address ogModule) internal {
        _execSafeTransaction(deployerPk, safeProxy, abi.encodeWithSignature("enableModule(address)", ogModule));
    }

    function logDeployment(
        address moduleProxyFactory,
        address safeProxy,
        address ogModule,
        Config memory config,
        address[] memory finalOwners
    ) internal pure {
        console2.log("=== Deployed ===");
        console2.log("ModuleProxyFactory:", moduleProxyFactory);
        console2.log("Safe:", safeProxy);
        console2.log("OptimisticGovernor module:", ogModule);
        console2.log("Identifier(bytes32):");
        console2.logBytes32(config.identifier);
        console2.log("Bond amount:");
        console2.logUint(config.bondAmount);
        console2.log("Liveness(seconds):");
        console2.logUint(uint256(config.liveness));
        console2.log("Safe owners:");
        for (uint256 i = 0; i < finalOwners.length; i++) {
            console2.logAddress(finalOwners[i]);
        }
        console2.log("Safe threshold:");
        console2.logUint(finalOwners.length);
    }
}
