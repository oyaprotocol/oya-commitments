// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";

contract HarnessMockSafe {
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
}

contract HarnessMockSafeProxyFactory {
    address public lastProxy;

    function createProxyWithNonce(address, bytes memory initializer, uint256) external returns (address proxy) {
        HarnessMockSafe safe = new HarnessMockSafe();
        (bool success,) = address(safe).call(initializer);
        require(success, "setup failed");
        lastProxy = address(safe);
        return lastProxy;
    }
}

contract HarnessMockOptimisticGovernor {
    struct Transaction {
        address to;
        uint8 operation;
        uint256 value;
        bytes data;
    }

    struct Proposal {
        Transaction[] transactions;
        uint256 requestTime;
    }

    struct EscalationManagerSettings {
        bool arbitrateViaEscalationManager;
        bool discardOracle;
        bool validateDisputers;
        address assertingCaller;
        address escalationManager;
    }

    struct Assertion {
        EscalationManagerSettings escalationManagerSettings;
        address asserter;
        uint64 assertionTime;
        bool settled;
        address currency;
        uint64 expirationTime;
        bool settlementResolution;
        bytes32 domainId;
        bytes32 identifier;
        uint256 bond;
        address callbackRecipient;
        address disputer;
    }

    address public owner;
    address public collateral;
    uint256 public bondAmount;
    address public optimisticOracleV3;
    string public rules;
    bytes32 public identifier;
    uint64 public liveness;
    mapping(bytes32 => bytes32) public assertionIds;
    mapping(bytes32 => Assertion) internal assertions;

    event TransactionsProposed(
        address indexed proposer,
        uint256 indexed proposalTime,
        bytes32 indexed assertionId,
        Proposal proposal,
        bytes32 proposalHash,
        bytes explanation,
        string rules,
        uint256 challengeWindowEnds
    );
    event ProposalExecuted(bytes32 indexed proposalHash, bytes32 indexed assertionId);
    event ProposalDeleted(bytes32 indexed proposalHash, bytes32 indexed assertionId);

    function setUp(bytes memory data) external {
        (owner, collateral, bondAmount, rules, identifier, liveness) =
            abi.decode(data, (address, address, uint256, string, bytes32, uint64));
        optimisticOracleV3 = address(this);
    }

    function proposeTransactions(Transaction[] calldata transactions, bytes calldata explanation)
        external
        returns (bytes32 proposalHash)
    {
        proposalHash = keccak256(abi.encode(transactions));
        bytes32 assertionId = keccak256(
            abi.encodePacked(proposalHash, msg.sender, block.timestamp, block.number)
        );
        assertionIds[proposalHash] = assertionId;

        Assertion storage assertion = assertions[assertionId];
        assertion.asserter = msg.sender;
        assertion.assertionTime = uint64(block.timestamp);
        assertion.settled = false;
        assertion.currency = collateral;
        assertion.expirationTime = uint64(block.timestamp) + liveness;
        assertion.settlementResolution = false;
        assertion.identifier = identifier;
        assertion.bond = bondAmount;

        Proposal memory proposal;
        proposal.requestTime = block.timestamp;
        proposal.transactions = new Transaction[](transactions.length);
        for (uint256 i = 0; i < transactions.length; i++) {
            proposal.transactions[i] = transactions[i];
        }

        emit TransactionsProposed(
            msg.sender,
            block.timestamp,
            assertionId,
            proposal,
            proposalHash,
            explanation,
            rules,
            block.timestamp + liveness
        );
    }

    function executeProposal(Transaction[] calldata transactions) external {
        bytes32 proposalHash = keccak256(abi.encode(transactions));
        bytes32 assertionId = assertionIds[proposalHash];
        require(assertionId != bytes32(0), "proposal not found");

        for (uint256 i = 0; i < transactions.length; i++) {
            require(transactions[i].operation == 0, "operation unsupported");
            (bool success,) = transactions[i].to.call{value: transactions[i].value}(transactions[i].data);
            require(success, "transaction failed");
        }

        assertions[assertionId].settled = true;
        assertions[assertionId].settlementResolution = true;
        emit ProposalExecuted(proposalHash, assertionId);
    }

    function deleteProposal(Transaction[] calldata transactions) external {
        bytes32 proposalHash = keccak256(abi.encode(transactions));
        bytes32 assertionId = assertionIds[proposalHash];
        require(assertionId != bytes32(0), "proposal not found");
        delete assertionIds[proposalHash];
        delete assertions[assertionId];
        emit ProposalDeleted(proposalHash, assertionId);
    }

    function getMinimumBond(address) external pure returns (uint256) {
        return 0;
    }

    function disputeAssertion(bytes32 assertionId, address disputer) external {
        assertions[assertionId].disputer = disputer;
    }

    function getAssertion(bytes32 assertionId) external view returns (Assertion memory assertion) {
        return assertions[assertionId];
    }
}

contract HarnessMockErc20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

contract HarnessMockPlaceholder {}

contract DeployHarnessMockCommitmentDeps is Script {
    function run()
        external
        returns (
            address safeSingleton,
            address safeProxyFactory,
            address safeFallbackHandler,
            address ogMasterCopy,
            address collateralToken
        )
    {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");

        vm.startBroadcast(deployerPk);
        safeSingleton = address(new HarnessMockPlaceholder());
        safeProxyFactory = address(new HarnessMockSafeProxyFactory());
        safeFallbackHandler = address(new HarnessMockPlaceholder());
        ogMasterCopy = address(new HarnessMockOptimisticGovernor());
        collateralToken = address(new HarnessMockErc20("Harness Mock USD", "HMUSD"));
        vm.stopBroadcast();

        return (safeSingleton, safeProxyFactory, safeFallbackHandler, ogMasterCopy, collateralToken);
    }
}
