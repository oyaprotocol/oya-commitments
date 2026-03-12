// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import {IERC1155Receiver, OyaTestERC1155} from "../src/OyaTestERC1155.sol";
import {DeployOyaTestERC1155} from "../script/DeployOyaTestERC1155.s.sol";
import {MintOyaTestERC1155} from "../script/MintOyaTestERC1155.s.sol";

contract MockERC1155Receiver is IERC1155Receiver {
    address public lastOperator;
    address public lastFrom;
    uint256 public lastId;
    uint256 public lastValue;
    bytes32 public lastDataHash;
    bytes32 public lastBatchIdsHash;
    bytes32 public lastBatchValuesHash;
    uint256 public lastBatchLength;

    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata data)
        external
        returns (bytes4)
    {
        lastOperator = operator;
        lastFrom = from;
        lastId = id;
        lastValue = value;
        lastDataHash = keccak256(data);
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) external returns (bytes4) {
        lastOperator = operator;
        lastFrom = from;
        lastBatchIdsHash = keccak256(abi.encode(ids));
        lastBatchValuesHash = keccak256(abi.encode(values));
        lastBatchLength = ids.length;
        lastDataHash = keccak256(data);
        return this.onERC1155BatchReceived.selector;
    }
}

contract NonReceiverContract {}

contract OyaTestERC1155Test is Test {
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    OyaTestERC1155 internal token;
    MockERC1155Receiver internal receiver;

    function setUp() public {
        token = new OyaTestERC1155(
            address(this), "Oya Test ERC1155", "OYAT1155", "https://example.invalid/oya-test-erc1155/{id}.json"
        );
        receiver = new MockERC1155Receiver();
    }

    function test_MintAndSafeTransferToReceiver() public {
        token.mint(ALICE, 42, 3, hex"1234");

        vm.prank(ALICE);
        token.safeTransferFrom(ALICE, address(receiver), 42, 2, hex"1234");

        assertEq(token.balanceOf(ALICE, 42), 1);
        assertEq(token.balanceOf(address(receiver), 42), 2);
        assertEq(token.totalSupply(42), 3);
        assertEq(receiver.lastOperator(), ALICE);
        assertEq(receiver.lastFrom(), ALICE);
        assertEq(receiver.lastId(), 42);
        assertEq(receiver.lastValue(), 2);
        assertEq(receiver.lastDataHash(), keccak256(hex"1234"));
    }

    function test_BatchMintAndSafeBatchTransferWithApproval() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = 7;
        ids[1] = 8;
        uint256[] memory mintAmounts = new uint256[](2);
        mintAmounts[0] = 5;
        mintAmounts[1] = 9;

        token.mintBatch(ALICE, ids, mintAmounts, "");

        vm.prank(ALICE);
        token.setApprovalForAll(BOB, true);

        uint256[] memory transferAmounts = new uint256[](2);
        transferAmounts[0] = 2;
        transferAmounts[1] = 4;
        vm.prank(BOB);
        token.safeBatchTransferFrom(ALICE, address(receiver), ids, transferAmounts, hex"beef");

        assertEq(token.balanceOf(ALICE, 7), 3);
        assertEq(token.balanceOf(ALICE, 8), 5);
        assertEq(token.balanceOf(address(receiver), 7), 2);
        assertEq(token.balanceOf(address(receiver), 8), 4);
        assertEq(receiver.lastOperator(), BOB);
        assertEq(receiver.lastFrom(), ALICE);
        assertEq(receiver.lastBatchIdsHash(), keccak256(abi.encode(ids)));
        assertEq(receiver.lastBatchValuesHash(), keccak256(abi.encode(transferAmounts)));
        assertEq(receiver.lastBatchLength(), 2);
        assertEq(receiver.lastDataHash(), keccak256(hex"beef"));
    }

    function test_SupportsExpectedInterfaces() public view {
        assertTrue(token.supportsInterface(0x01ffc9a7));
        assertTrue(token.supportsInterface(0xd9b67a26));
        assertTrue(token.supportsInterface(0x0e89341c));
        assertFalse(token.supportsInterface(0xffffffff));
    }

    function test_RevertWhen_NonOwnerMints() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(OyaTestERC1155.NotOwner.selector, ALICE));
        token.mint(ALICE, 1, 1, "");
    }

    function test_RevertWhen_RecipientCannotReceiveErc1155() public {
        NonReceiverContract nonReceiver = new NonReceiverContract();
        token.mint(ALICE, 1, 1, "");

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(OyaTestERC1155.UnsafeRecipient.selector, address(nonReceiver)));
        token.safeTransferFrom(ALICE, address(nonReceiver), 1, 1, "");
    }
}

contract OyaTestERC1155ScriptTest is Test {
    function test_DeployScriptDeploysConfiguredToken() public {
        DeployOyaTestERC1155 script = new DeployOyaTestERC1155();

        vm.setEnv("DEPLOYER_PK", "1");
        vm.setEnv("TEST_ERC1155_OWNER", vm.toString(address(0xBEEF)));
        vm.setEnv("TEST_ERC1155_NAME", "Sepolia Oya Test ERC1155");
        vm.setEnv("TEST_ERC1155_SYMBOL", "SOYA1155");
        vm.setEnv("TEST_ERC1155_URI", "ipfs://oya-test/{id}.json");

        script.run();
        OyaTestERC1155 deployedToken = script.token();

        assertEq(deployedToken.owner(), address(0xBEEF));
        assertEq(deployedToken.name(), "Sepolia Oya Test ERC1155");
        assertEq(deployedToken.symbol(), "SOYA1155");
        assertEq(deployedToken.uri(1), "ipfs://oya-test/{id}.json");
    }

    function test_MintScriptMintsConfiguredTokenId() public {
        DeployOyaTestERC1155 deployScript = new DeployOyaTestERC1155();
        MintOyaTestERC1155 mintScript = new MintOyaTestERC1155();
        address recipient = address(0xCAFE);

        vm.setEnv("DEPLOYER_PK", "1");
        vm.setEnv("TEST_ERC1155_OWNER", vm.toString(vm.addr(1)));
        deployScript.run();
        OyaTestERC1155 deployedToken = deployScript.token();

        vm.setEnv("MINTER_PK", "1");
        vm.setEnv("TEST_ERC1155_TOKEN", vm.toString(address(deployedToken)));
        vm.setEnv("TEST_ERC1155_TO", vm.toString(recipient));
        vm.setEnv("TEST_ERC1155_TOKEN_ID", "77");
        vm.setEnv("TEST_ERC1155_AMOUNT", "9");
        vm.setEnv("TEST_ERC1155_DATA", "0x1234");

        mintScript.run();

        assertEq(deployedToken.balanceOf(recipient, 77), 9);
        assertEq(deployedToken.totalSupply(77), 9);
    }
}
