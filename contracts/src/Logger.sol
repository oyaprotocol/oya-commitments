// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Records claims linking callers to IPFS CIDs.
/// @dev A log does not verify CID syntax, content validity, or availability.
contract Logger {
    error EmptyCid();

    event Log(address indexed node, string cid);

    /// @notice Record a CID claim attributed to the immediate caller.
    /// @param cid A nonempty string, preserved exactly. Repeated submissions are allowed.
    function log(string calldata cid) external {
        if (bytes(cid).length == 0) revert EmptyCid();
        emit Log(msg.sender, cid);
    }
}
