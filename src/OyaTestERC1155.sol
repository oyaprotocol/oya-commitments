// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC1155Receiver {
    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata data)
        external
        returns (bytes4);

    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) external returns (bytes4);
}

contract OyaTestERC1155 {
    error ArrayLengthMismatch();
    error InsufficientBalance(address account, uint256 id, uint256 available, uint256 required);
    error MissingApprovalForAll(address operator, address owner);
    error NotOwner(address caller);
    error UnsafeRecipient(address recipient);
    error ZeroAddress();

    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event TransferBatch(
        address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values
    );
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event URI(string value, uint256 indexed id);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    bytes4 private constant INTERFACE_ID_ERC165 = 0x01ffc9a7;
    bytes4 private constant INTERFACE_ID_ERC1155 = 0xd9b67a26;
    bytes4 private constant INTERFACE_ID_ERC1155_METADATA_URI = 0x0e89341c;

    string public name;
    string public symbol;
    address public owner;
    string private baseUri;

    mapping(address account => mapping(uint256 id => uint256 amount)) private balances;
    mapping(address account => mapping(address operator => bool approved)) private operatorApprovals;
    mapping(uint256 id => uint256 supply) public totalSupply;

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert NotOwner(msg.sender);
        }
        _;
    }

    constructor(address initialOwner, string memory tokenName, string memory tokenSymbol, string memory initialUri) {
        if (initialOwner == address(0)) {
            revert ZeroAddress();
        }

        owner = initialOwner;
        name = tokenName;
        symbol = tokenSymbol;
        baseUri = initialUri;

        emit OwnershipTransferred(address(0), initialOwner);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == INTERFACE_ID_ERC165 || interfaceId == INTERFACE_ID_ERC1155
            || interfaceId == INTERFACE_ID_ERC1155_METADATA_URI;
    }

    function uri(uint256) external view returns (string memory) {
        return baseUri;
    }

    function balanceOf(address account, uint256 id) public view returns (uint256) {
        if (account == address(0)) {
            revert ZeroAddress();
        }
        return balances[account][id];
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids)
        external
        view
        returns (uint256[] memory)
    {
        if (accounts.length != ids.length) {
            revert ArrayLengthMismatch();
        }

        uint256[] memory batchBalances = new uint256[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            batchBalances[i] = balanceOf(accounts[i], ids[i]);
        }
        return batchBalances;
    }

    function isApprovedForAll(address account, address operator) public view returns (bool) {
        return operatorApprovals[account][operator];
    }

    function setApprovalForAll(address operator, bool approved) external {
        operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external {
        if (from != msg.sender && !isApprovedForAll(from, msg.sender)) {
            revert MissingApprovalForAll(msg.sender, from);
        }

        _safeTransferFrom(msg.sender, from, to, id, amount, data);
    }

    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) external {
        if (ids.length != amounts.length) {
            revert ArrayLengthMismatch();
        }
        if (from != msg.sender && !isApprovedForAll(from, msg.sender)) {
            revert MissingApprovalForAll(msg.sender, from);
        }

        _safeBatchTransferFrom(msg.sender, from, to, ids, amounts, data);
    }

    function mint(address to, uint256 id, uint256 amount, bytes calldata data) external onlyOwner {
        _mint(msg.sender, to, id, amount, data);
    }

    function mintBatch(address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data)
        external
        onlyOwner
    {
        if (ids.length != amounts.length) {
            revert ArrayLengthMismatch();
        }

        _mintBatch(msg.sender, to, ids, amounts, data);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) {
            revert ZeroAddress();
        }

        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function _safeTransferFrom(
        address operator,
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes memory data
    ) internal {
        if (to == address(0)) {
            revert ZeroAddress();
        }

        uint256 fromBalance = balances[from][id];
        if (fromBalance < amount) {
            revert InsufficientBalance(from, id, fromBalance, amount);
        }

        unchecked {
            balances[from][id] = fromBalance - amount;
        }
        balances[to][id] += amount;

        emit TransferSingle(operator, from, to, id, amount);

        _doSafeTransferAcceptanceCheck(operator, from, to, id, amount, data);
    }

    function _safeBatchTransferFrom(
        address operator,
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) internal {
        if (to == address(0)) {
            revert ZeroAddress();
        }

        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            uint256 amount = amounts[i];
            uint256 fromBalance = balances[from][id];
            if (fromBalance < amount) {
                revert InsufficientBalance(from, id, fromBalance, amount);
            }

            unchecked {
                balances[from][id] = fromBalance - amount;
            }
            balances[to][id] += amount;
        }

        emit TransferBatch(operator, from, to, ids, amounts);

        _doSafeBatchTransferAcceptanceCheck(operator, from, to, ids, amounts, data);
    }

    function _mint(address operator, address to, uint256 id, uint256 amount, bytes memory data) internal {
        if (to == address(0)) {
            revert ZeroAddress();
        }

        balances[to][id] += amount;
        totalSupply[id] += amount;

        emit TransferSingle(operator, address(0), to, id, amount);

        _doSafeTransferAcceptanceCheck(operator, address(0), to, id, amount, data);
    }

    function _mintBatch(
        address operator,
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) internal {
        if (to == address(0)) {
            revert ZeroAddress();
        }

        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            uint256 amount = amounts[i];
            balances[to][id] += amount;
            totalSupply[id] += amount;
        }

        emit TransferBatch(operator, address(0), to, ids, amounts);

        _doSafeBatchTransferAcceptanceCheck(operator, address(0), to, ids, amounts, data);
    }

    function _doSafeTransferAcceptanceCheck(
        address operator,
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes memory data
    ) private {
        if (to.code.length == 0) {
            return;
        }

        try IERC1155Receiver(to).onERC1155Received(operator, from, id, amount, data) returns (bytes4 response) {
            if (response != IERC1155Receiver.onERC1155Received.selector) {
                revert UnsafeRecipient(to);
            }
        } catch (bytes memory reason) {
            if (reason.length == 0) {
                revert UnsafeRecipient(to);
            }
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
    }

    function _doSafeBatchTransferAcceptanceCheck(
        address operator,
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) private {
        if (to.code.length == 0) {
            return;
        }

        try IERC1155Receiver(to).onERC1155BatchReceived(operator, from, ids, amounts, data) returns (bytes4 response) {
            if (response != IERC1155Receiver.onERC1155BatchReceived.selector) {
                revert UnsafeRecipient(to);
            }
        } catch (bytes memory reason) {
            if (reason.length == 0) {
                revert UnsafeRecipient(to);
            }
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
    }
}
