// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Records claims linking callers to IPFS CIDs.
/// @dev A log does not verify CID syntax, content validity, or availability.
contract Logger {
    event Log(address indexed node, string cid);

    /// @notice Record a CID claim attributed to the immediate caller.
    /// @param cid An opaque string, preserved exactly. Empty and repeated submissions are allowed.
    function log(string calldata cid) external {
        emit Log(msg.sender, cid);
    }
}
