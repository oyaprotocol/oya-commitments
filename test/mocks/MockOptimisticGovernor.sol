// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract MockOptimisticGovernor {
    address public collateral;
    uint256 public bondAmount;
    address public optimisticOracleV3;
    string public rules;
    bytes32 public identifier;
    uint64 public liveness;

    constructor(
        address _collateral,
        uint256 _bondAmount,
        address _optimisticOracleV3,
        string memory _rules,
        bytes32 _identifier,
        uint64 _liveness
    ) {
        collateral = _collateral;
        bondAmount = _bondAmount;
        optimisticOracleV3 = _optimisticOracleV3;
        rules = _rules;
        identifier = _identifier;
        liveness = _liveness;
    }
}
