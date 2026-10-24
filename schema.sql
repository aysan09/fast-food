CREATE DATABASE IF NOT EXISTS seba_cafe CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE seba_cafe;

CREATE TABLE IF NOT EXISTS restaurant_tables (
    id INT AUTO_INCREMENT PRIMARY KEY,
    table_number VARCHAR(10) NOT NULL UNIQUE,
    qr_code_url VARCHAR(255) NOT NULL,
    status ENUM('available', 'occupied', 'reserved') DEFAULT 'available'
);

CREATE TABLE IF NOT EXISTS categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    display_order INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    category_id INT NOT NULL,
    name VARCHAR(150) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    image_url VARCHAR(255) NULL,
    description VARCHAR(255) NULL,
    is_available BOOLEAN DEFAULT TRUE,
    status ENUM('in_stock', 'out_of_stock', 'out_of_order') DEFAULT 'in_stock',
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(190) NOT NULL UNIQUE,
    password_hash VARCHAR(200) NOT NULL,
    role ENUM('admin', 'cashier', 'waiter') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    public_token CHAR(64) NOT NULL UNIQUE,
    table_number VARCHAR(10) NOT NULL,
    order_type ENUM('qr_self_service', 'waiter_assisted') DEFAULT 'qr_self_service',
    payment_method ENUM('digital_aggregator', 'telebirr_transfer', 'cbe_transfer', 'cash') NOT NULL,
    payment_channel VARCHAR(32) NULL,
    payment_status ENUM('pending_approval', 'verified', 'rejected', 'unpaid', 'processing', 'paid', 'failed') DEFAULT 'pending_approval',
    payment_screenshot_url VARCHAR(255) NULL,
    rejection_reason VARCHAR(255) NULL,
    status ENUM('pending_approval', 'in_kitchen', 'ready', 'completed', 'cancelled') DEFAULT 'pending_approval',
    transaction_reference VARCHAR(150) NULL UNIQUE,
    provider_reference VARCHAR(150) NULL,
    customer_first_name VARCHAR(100) NULL,
    customer_last_name VARCHAR(100) NULL,
    customer_email VARCHAR(190) NULL,
    total_amount DECIMAL(10,2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_orders_active (status, created_at),
    INDEX idx_orders_payment (payment_status, payment_method),
    INDEX idx_orders_table (table_number, status),
    CONSTRAINT fk_orders_table FOREIGN KEY (table_number) REFERENCES restaurant_tables(table_number)
);

CREATE TABLE IF NOT EXISTS order_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    menu_item_id INT NOT NULL,
    quantity INT NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id)
);

INSERT INTO restaurant_tables (table_number, qr_code_url) VALUES
('01', '/?table=01#/menu'), ('02', '/?table=02#/menu'), ('03', '/?table=03#/menu'),
('04', '/?table=04#/menu'), ('05', '/?table=05#/menu'), ('06', '/?table=06#/menu'),
('07', '/?table=07#/menu'), ('08', '/?table=08#/menu'), ('09', '/?table=09#/menu'),
('10', '/?table=10#/menu'), ('11', '/?table=11#/menu'), ('12', '/?table=12#/menu'),
('13', '/?table=13#/menu'), ('14', '/?table=14#/menu')
ON DUPLICATE KEY UPDATE qr_code_url = VALUES(qr_code_url);

INSERT INTO categories (name, display_order) VALUES
('Burgers', 1), ('Combos', 2), ('Sides', 3), ('Drinks', 4), ('Desserts', 5)
ON DUPLICATE KEY UPDATE display_order = VALUES(display_order);

INSERT INTO menu_items (category_id, name, price, image_url, description, status)
SELECT c.id, seed.name, seed.price, seed.image_url, seed.description, seed.status
FROM (
    SELECT 'Burgers' category_name, 'Classic Smash Burger' name, 680.00 price, 'photo-1568901346375-23c9450c58cd' image_url, 'Double-seared beef, aged cheddar, Seba sauce.' description, 'in_stock' status
    UNION ALL SELECT 'Combos', 'Double Smash Combo', 980.00, 'photo-1550547660-d9450f859349', 'Two patties, golden fries and a cold drink.', 'in_stock'
    UNION ALL SELECT 'Burgers', 'Crispy Chicken Burger', 620.00, 'photo-1606755962773-d324e0a13086', 'Buttermilk crunch, slaw and pepper mayo.', 'in_stock'
    UNION ALL SELECT 'Sides', 'Rosemary Fries', 280.00, 'photo-1573080496219-bb080dd4f877', 'Hand-cut potatoes, rosemary salt.', 'in_stock'
    UNION ALL SELECT 'Drinks', 'Fresh Orange Juice', 220.00, 'photo-1613478223719-2ab802602423', 'Pressed to order. Bright, sweet and fresh.', 'in_stock'
    UNION ALL SELECT 'Drinks', 'Chilled Coca-Cola', 120.00, 'photo-1554866585-cd94860890b7', 'An ice-cold classic, served chilled.', 'out_of_stock'
    UNION ALL SELECT 'Sides', 'Green Garden Salad', 390.00, 'photo-1512621776951-a57141f2eefd', 'Market greens, avocado and lemon dressing.', 'in_stock'
    UNION ALL SELECT 'Desserts', 'Warm Chocolate Brownie', 330.00, 'photo-1606313564200-e75d5e30476c', 'Fudgy dark chocolate, baked in-house.', 'in_stock'
) AS seed
JOIN categories c ON c.name = seed.category_name
WHERE NOT EXISTS (
    SELECT 1 FROM menu_items existing
    WHERE existing.category_id = c.id AND existing.name = seed.name
);