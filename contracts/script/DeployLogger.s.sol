// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script} from "forge-std/Script.sol";
import {Logger} from "../src/Logger.sol";

contract DeployLogger is Script {
    function run() external returns (Logger logger) {
        uint256 expectedChainId = vm.envUint("LOGGER_CHAIN_ID");
        require(block.chainid == expectedChainId, "Unexpected deployment chain");
        vm.startBroadcast(vm.envUint("LOGGER_DEPLOYER_PK"));
        logger = new Logger();
        vm.stopBroadcast();
    }
}
