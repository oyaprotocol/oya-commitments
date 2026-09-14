// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script} from "forge-std/Script.sol";
import {Ledger} from "../src/Ledger.sol";

contract DeployLedger is Script {
    function run() external returns (Ledger ledger) {
        uint256 expectedChainId = vm.envUint("LEDGER_CHAIN_ID");
        require(block.chainid == expectedChainId, "Unexpected deployment chain");
        vm.startBroadcast(vm.envUint("LEDGER_DEPLOYER_PK"));
        ledger = new Ledger();
        vm.stopBroadcast();
    }
}
