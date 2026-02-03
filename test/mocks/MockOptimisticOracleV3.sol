// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./MockERC20.sol";

contract MockOptimisticOracleV3 {
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
        MockERC20 currency;
        uint64 expirationTime;
        bool settlementResolution;
        bytes32 domainId;
        bytes32 identifier;
        uint256 bond;
        address callbackRecipient;
        address disputer;
    }

    mapping(bytes32 => Assertion) private assertions;

    event AssertionDisputed(bytes32 indexed assertionId, address indexed caller, address indexed disputer);

    function setAssertion(bytes32 assertionId, Assertion memory assertion) external {
        assertions[assertionId] = assertion;
    }

    function setAssertionSimple(
        bytes32 assertionId,
        address asserter,
        uint64 assertionTime,
        bool settled,
        address currency,
        uint64 expirationTime,
        bytes32 identifier,
        uint256 bond
    ) external {
        Assertion storage assertion = assertions[assertionId];
        assertion.asserter = asserter;
        assertion.assertionTime = assertionTime;
        assertion.settled = settled;
        assertion.currency = MockERC20(currency);
        assertion.expirationTime = expirationTime;
        assertion.identifier = identifier;
        assertion.bond = bond;
        assertion.domainId = bytes32(0);
        assertion.callbackRecipient = address(0);
        assertion.disputer = address(0);
    }

    function getAssertion(bytes32 assertionId) external view returns (Assertion memory) {
        return assertions[assertionId];
    }

    function disputeAssertion(bytes32 assertionId, address disputer) external {
        Assertion storage assertion = assertions[assertionId];
        require(assertion.asserter != address(0), "missing");
        require(!assertion.settled, "settled");
        require(assertion.disputer == address(0), "already-disputed");
        require(block.timestamp < assertion.expirationTime, "expired");

        if (assertion.bond > 0) {
            bool success = assertion.currency.transferFrom(msg.sender, address(this), assertion.bond);
            require(success, "bond-transfer");
        }

        assertion.disputer = disputer;
        emit AssertionDisputed(assertionId, msg.sender, disputer);
    }
}
