// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";

/// ------------------------
/// Minimal interfaces
/// ------------------------

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

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

contract DeploySafeWithOptimisticGovernor is Script {
    // Safe tx operation enum
    uint8 internal constant OP_CALL = 0;

    struct Config {
        address safeSingleton;
        address safeProxyFactory;
        address safeFallbackHandler;
        address ogMasterCopy;
        address collateral;
        uint256 bondAmount;
        uint64 liveness;
        bytes32 identifier;
        uint256 safeSaltNonce;
        uint256 ogSaltNonce;
    }

    address internal constant BURN_OWNER = 0x000000000000000000000000000000000000dEaD;
    address internal constant SENTINEL_OWNERS = 0x0000000000000000000000000000000000000001;

    function run() external {
        // ---------
        // Required
        // ---------
        uint256 DEPLOYER_PK = vm.envUint("DEPLOYER_PK");
        Config memory config = loadConfig();
        string memory rules = vm.envString("OG_RULES");

        // safe owners config (script is designed for 1-owner bootstrap so it can auto-exec enableModule)
        // You can later rotate owners/threshold via a Safe tx or by proposing through OG.
        address deployer = vm.addr(DEPLOYER_PK);
        address[] memory owners = new address[](1);
        owners[0] = deployer;
        uint256 threshold = 1;

        vm.startBroadcast(DEPLOYER_PK);

        address moduleProxyFactory = resolveModuleProxyFactory();
        address safeProxy = deploySafeProxy(config, owners, threshold);
        address ogModule = deployOptimisticGovernor(config, moduleProxyFactory, safeProxy, rules);

        enableModule(DEPLOYER_PK, safeProxy, ogModule);
        burnOwner(DEPLOYER_PK, safeProxy);

        vm.stopBroadcast();

        logDeployment(moduleProxyFactory, safeProxy, ogModule, config);
    }

    function loadConfig() internal returns (Config memory config) {
        // ------------
        // Addresses (override these per network)
        // ------------
        config.safeSingleton = vm.envOr(
            "SAFE_SINGLETON",
            address(0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552) // Safe v1.3.0 singleton :contentReference[oaicite:9]{index=9}
        );

        config.safeProxyFactory = vm.envOr(
            "SAFE_PROXY_FACTORY",
            address(0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2) // Safe v1.3.0 proxy factory :contentReference[oaicite:10]{index=10}
        );

        config.safeFallbackHandler = vm.envOr(
            "SAFE_FALLBACK_HANDLER",
            address(0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4) // CompatibilityFallbackHandler 1.3.0 :contentReference[oaicite:11]{index=11}
        );

        // UMA OptimisticGovernor mastercopy (mainnet). Override on other chains.
        config.ogMasterCopy = vm.envOr(
            "OG_MASTER_COPY",
            address(0x28CeBFE94a03DbCA9d17143e9d2Bd1155DC26D5d) // :contentReference[oaicite:12]{index=12}
        );

        // ------------
        // Governance params
        // ------------
        config.collateral = vm.envAddress("OG_COLLATERAL"); // must be UMA-whitelisted or setUp will revert :contentReference[oaicite:13]{index=13}
        config.bondAmount = vm.envUint("OG_BOND_AMOUNT");
        config.liveness = uint64(vm.envOr("OG_LIVENESS", uint256(2 days))); // seconds

        // Identifier (bytes32). Default "ASSERT_TRUTH2" for UMA Optimistic Oracle. :contentReference[oaicite:14]{index=14}
        string memory identifierStr = vm.envOr("OG_IDENTIFIER_STR", string("ASSERT_TRUTH2"));
        config.identifier = bytes32(bytes(identifierStr)); // "ZODIAC" fits in 32 bytes.

        // salts
        config.safeSaltNonce = vm.envOr("SAFE_SALT_NONCE", uint256(1));
        config.ogSaltNonce = vm.envOr("OG_SALT_NONCE", uint256(1));
    }

    function resolveModuleProxyFactory() internal returns (address moduleProxyFactory) {
        // 1) Deploy (or use) ModuleProxyFactory
        //    (You can also set MODULE_PROXY_FACTORY env and skip deployment if you prefer.)
        moduleProxyFactory = vm.envOr("MODULE_PROXY_FACTORY", address(0));
        if (moduleProxyFactory == address(0)) {
            ModuleProxyFactory mpf = new ModuleProxyFactory();
            moduleProxyFactory = address(mpf);
        }
    }

    function deploySafeProxy(Config memory config, address[] memory owners, uint256 threshold)
        internal
        returns (address safeProxy)
    {
        bytes memory safeInitializer = abi.encodeWithSelector(
            ISafe.setup.selector,
            owners,
            threshold,
            address(0), // to
            bytes(""), // data
            config.safeFallbackHandler,
            address(0), // paymentToken
            0, // payment
            payable(address(0)) // paymentReceiver
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
        // 3) Deploy OptimisticGovernor instance (as module proxy) and initialize via setUp(bytes)
        // setUp decodes: (owner, collateral, bondAmount, rules, identifier, liveness) :contentReference[oaicite:16]{index=16}
        bytes memory ogInitParams =
            abi.encode(safeProxy, config.collateral, config.bondAmount, rules, config.identifier, config.liveness);

        bytes memory ogInitializerCall = abi.encodeWithSignature("setUp(bytes)", ogInitParams);

        ogModule = IModuleProxyFactory(moduleProxyFactory)
            .deployModule(config.ogMasterCopy, ogInitializerCall, config.ogSaltNonce);
    }

    function enableModule(uint256 deployerPk, address safeProxy, address ogModule) internal {
        // 4) Enable the module on the Safe by executing a Safe tx:
        // Safe.enableModule(ogModule) must be called by the Safe itself, so we execTransaction.
        bytes memory enableModuleCalldata = abi.encodeWithSignature("enableModule(address)", ogModule);

        ISafe safe = ISafe(safeProxy);
        uint256 safeNonce = safe.nonce();

        bytes32 txHash = safe.getTransactionHash(
            safeProxy, // to = safe itself
            0, // value
            enableModuleCalldata, // data
            OP_CALL, // operation
            0,
            0,
            0, // safeTxGas, baseGas, gasPrice
            address(0), // gasToken
            address(0), // refundReceiver
            safeNonce
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(deployerPk, txHash);
        bytes memory sig = abi.encodePacked(r, s, v); // EIP-712 signature (no eth_sign prefix)

        bool ok = safe.execTransaction(
            safeProxy, 0, enableModuleCalldata, OP_CALL, 0, 0, 0, address(0), payable(address(0)), sig
        );
        require(ok, "enableModule execTransaction failed");
    }

    function burnOwner(uint256 deployerPk, address safeProxy) internal {
        ISafe safe = ISafe(safeProxy);

        // Add burn owner
        bytes memory addOwnerCalldata = abi.encodeWithSignature(
            "addOwnerWithThreshold(address,uint256)", BURN_OWNER, 1
        );

        bytes32 addOwnerTxHash = safe.getTransactionHash(
            safeProxy,
            0,
            addOwnerCalldata,
            OP_CALL,
            0,
            0,
            0,
            address(0),
            address(0),
            safe.nonce()
        );

        (uint8 addV, bytes32 addR, bytes32 addS) = vm.sign(deployerPk, addOwnerTxHash);
        bytes memory addSig = abi.encodePacked(addR, addS, addV);

        bool addOk = safe.execTransaction(
            safeProxy, 0, addOwnerCalldata, OP_CALL, 0, 0, 0, address(0), payable(address(0)), addSig
        );
        require(addOk, "add burn owner failed");

        // Remove deployer owner
        bytes memory removeOwnerCalldata = abi.encodeWithSignature(
            "removeOwner(address,address,uint256)", BURN_OWNER, vm.addr(deployerPk), 1
        );

        bytes32 removeOwnerTxHash = safe.getTransactionHash(
            safeProxy,
            0,
            removeOwnerCalldata,
            OP_CALL,
            0,
            0,
            0,
            address(0),
            address(0),
            safe.nonce()
        );

        (uint8 remV, bytes32 remR, bytes32 remS) = vm.sign(deployerPk, removeOwnerTxHash);
        bytes memory remSig = abi.encodePacked(remR, remS, remV);

        bool remOk = safe.execTransaction(
            safeProxy, 0, removeOwnerCalldata, OP_CALL, 0, 0, 0, address(0), payable(address(0)), remSig
        );
        require(remOk, "remove deployer owner failed");
    }

    function logDeployment(address moduleProxyFactory, address safeProxy, address ogModule, Config memory config)
        internal
    {
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
    }
}
