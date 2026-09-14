// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Ledger} from "../src/Ledger.sol";

contract LedgerCaller {
    function forward(Ledger ledger, string calldata cid) external {
        ledger.log(cid);
    }
}

contract LedgerTest is Test {
    Ledger internal ledger;

    string internal constant CID = "QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH";

    function setUp() public {
        ledger = new Ledger();
    }

    function test_LogsCallerAndExactCid() public {
        address node = address(0xA11CE);
        vm.recordLogs();
        vm.prank(node);
        ledger.log(CID);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        assertEq(entries.length, 1);
        assertLog(entries[0], node, CID);
    }

    function test_LogsEmptyCid() public {
        vm.recordLogs();
        ledger.log("");

        Vm.Log[] memory entries = vm.getRecordedLogs();
        assertEq(entries.length, 1);
        assertLog(entries[0], address(this), "");
    }

    function test_RecordsRepeatedSubmissionsSeparately() public {
        address node = address(0xA11CE);
        vm.recordLogs();
        vm.startPrank(node);
        ledger.log(CID);
        ledger.log(CID);
        vm.stopPrank();

        Vm.Log[] memory entries = vm.getRecordedLogs();
        assertEq(entries.length, 2);
        assertLog(entries[0], node, CID);
        assertLog(entries[1], node, CID);
    }

    function test_RecordsDifferentCallersInSubmissionOrder() public {
        address firstNode = address(0xA11CE);
        address secondNode = address(0xB0B);
        string memory secondCid = "bafy-second-claim";
        vm.recordLogs();
        vm.prank(firstNode);
        ledger.log(CID);
        vm.prank(secondNode);
        ledger.log(secondCid);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        assertEq(entries.length, 2);
        assertLog(entries[0], firstNode, CID);
        assertLog(entries[1], secondNode, secondCid);
    }

    function test_AttributesForwardedCallsToTheCallingContract() public {
        LedgerCaller caller = new LedgerCaller();
        address origin = address(0xA11CE);
        vm.recordLogs();
        vm.prank(origin, origin);
        caller.forward(ledger, CID);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        assertEq(entries.length, 1);
        assertLog(entries[0], address(caller), CID);
    }

    function test_PreservesOpaqueStrings() public {
        // Syntax and content policy belong to the host.
        string memory claim = unicode"  arbitrary claim: café\n";
        vm.recordLogs();
        ledger.log(claim);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        assertEq(entries.length, 1);
        assertLog(entries[0], address(this), claim);
    }

    function test_RejectsNativeTokenValue() public {
        vm.deal(address(this), 1 ether);
        vm.recordLogs();
        (bool success,) = address(ledger).call{value: 1 wei}(abi.encodeCall(Ledger.log, (CID)));

        assertFalse(success);
        assertEq(address(ledger).balance, 0);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function testFuzz_PreservesCallerAndCid(address node, string memory cid) public {
        vm.recordLogs();
        vm.prank(node);
        ledger.log(cid);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        assertEq(entries.length, 1);
        assertLog(entries[0], node, cid);
    }

    function assertLog(Vm.Log memory entry, address node, string memory cid) internal view {
        assertEq(entry.emitter, address(ledger));
        assertEq(entry.topics.length, 3);
        assertEq(entry.topics[0], keccak256("Log(address,bytes32,string)"));
        assertEq(entry.topics[1], bytes32(uint256(uint160(node))));
        assertEq(entry.topics[2], keccak256(bytes(cid)));
        assertEq(entry.data, abi.encode(cid));
        assertEq(abi.decode(entry.data, (string)), cid);
    }
}
