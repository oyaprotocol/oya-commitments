// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";

interface IOyaTestERC1155Mint {
    function mint(address to, uint256 id, uint256 amount, bytes calldata data) external;
}

contract MintOyaTestERC1155 is Script {
    function run() external {
        uint256 minterPk = vm.envOr("MINTER_PK", uint256(0));
        if (minterPk == 0) {
            minterPk = vm.envUint("DEPLOYER_PK");
        }

        address token = vm.envAddress("TEST_ERC1155_TOKEN");
        address to = vm.envAddress("TEST_ERC1155_TO");
        uint256 tokenId = vm.envUint("TEST_ERC1155_TOKEN_ID");
        uint256 amount = vm.envUint("TEST_ERC1155_AMOUNT");
        bytes memory data = vm.parseBytes(vm.envOr("TEST_ERC1155_DATA", string("0x")));

        vm.startBroadcast(minterPk);
        IOyaTestERC1155Mint(token).mint(to, tokenId, amount, data);
        vm.stopBroadcast();

        console2.log("Minted OyaTestERC1155");
        console2.log("Token:");
        console2.logAddress(token);
        console2.log("To:");
        console2.logAddress(to);
        console2.log("Token ID:");
        console2.logUint(tokenId);
        console2.log("Amount:");
        console2.logUint(amount);
    }
}
