// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import {OyaTestERC1155} from "../src/OyaTestERC1155.sol";

contract DeployOyaTestERC1155 is Script {
    OyaTestERC1155 public token;

    function run() external returns (OyaTestERC1155 deployedToken) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(deployerPk);
        address owner = deployer;
        if (vm.envExists("TEST_ERC1155_OWNER")) {
            owner = vm.envAddress("TEST_ERC1155_OWNER");
        }
        string memory name = vm.envOr("TEST_ERC1155_NAME", string("Oya Test ERC1155"));
        string memory symbol = vm.envOr("TEST_ERC1155_SYMBOL", string("OYAT1155"));
        string memory metadataUri =
            vm.envOr("TEST_ERC1155_URI", string("https://example.invalid/oya-test-erc1155/{id}.json"));

        vm.startBroadcast(deployerPk);
        token = new OyaTestERC1155(owner, name, symbol, metadataUri);
        vm.stopBroadcast();

        console2.log("OyaTestERC1155 deployed:");
        console2.logAddress(address(token));
        console2.log("Owner:");
        console2.logAddress(owner);
        console2.log("Name:");
        console2.log(name);
        console2.log("Symbol:");
        console2.log(symbol);
        console2.log("URI:");
        console2.log(metadataUri);

        return token;
    }
}
