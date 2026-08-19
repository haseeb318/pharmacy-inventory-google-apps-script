# Pharmacy Inventory Management System

A Google Apps Script based pharmacy management and inventory system built for Google Sheets. This project helps pharmacies and healthcare stores manage medicines, stock levels, supplier purchases, sales, expiry tracking, reports, and user access from a web application.

## Overview

This application is designed as a lightweight, low-cost pharmacy inventory and sales system using Google Apps Script and Google Sheets as the data layer. It provides a browser-based dashboard for staff and administrators to manage medicine stock, track incoming and outgoing inventory, identify expiring items, and review reports.

## Features

### Pharmacy Inventory Management

- Manage medicine and product items with master data such as name, category, SKU, pricing, and minimum stock level
- Track inventory stock across purchase and sales transactions
- Monitor low-stock items and stock alerts
- Support item-wise inventory summaries and batch-level stock visibility

### Purchase and Sales Tracking

- Record supplier purchases and purchase batches
- Capture item quantity, unit cost, selling price, supplier, and purchase date
- Process sales transactions with customer information and payment details
- Support multi-item sales and batch allocation logic
- Maintain sales records with invoice references and item-level breakdowns

### Expiry and Batch Tracking

- Track purchase batches, batch numbers, and expiry dates
- Highlight items nearing expiry
- Sort batch allocation based on expiry dates to improve stock rotation
- Detect expired or near-expiry stock in inventory views and dashboard summaries

### Dashboard and KPIs

- View overview metrics such as total sales, total purchases, stock counts, and recent activities
- Monitor sales and purchase trends through dashboard summaries
- Quickly identify inventory issues and expiring medicine stock

### Reports and Analytics

- Generate sales and purchase reports for selected date ranges
- Review low-stock items and inventory status
- Prepare export-ready report data in supported formats
- Support operational reporting for pharmacy management teams

### User and Access Management

- Role-based access for administrators and staff
- Login/logout session handling through Apps Script cache and properties
- User management for active/inactive accounts
- Settings configurability for application-level control

### Google Sheets Integration

- Uses Google Sheets as the primary data store
- Auto-creates and maintains required sheets for inventory, purchases, sales, users, and settings
- Works well as a Google Sheets app for daily pharmacy operations

### Web App Experience

- Browser-based interface using HTML, CSS, and JavaScript embedded in the Apps Script project
- Easy deployment as a web application inside Google Workspace
- Suitable for internal pharmacy workflows and healthcare inventory operations

## Tech Stack

- Google Apps Script
- Google Sheets
- JavaScript
- HTML/CSS
- Web App deployment through Apps Script

## Typical Workflow

1. Add medicine items to the item master list
2. Record purchase entries with batch and expiry details
3. Update inventory stock as sales happen
4. Monitor dashboard KPIs and low-stock alerts
5. Review expiry tracking and generate reports
6. Manage roles, users, and business settings

## Project Structure

- Code.gs — app bootstrap and entry points
- Items.gs — item master management
- Inventory.gs — inventory summaries and expiry logic
- Purchases.gs — purchase records and batch handling
- Sales.gs — sales processing and batch allocation
- Reports.gs — report generation
- Dashboard.gs — dashboard metrics
- Users.gs — user management
- Settings.gs — app settings
- Auth.gs — login and authentication
- Utils.gs — helper functions and utilities
- HTML files — web interface parts

## Setup and Deployment

1. Open this project in the Google Apps Script editor.
2. Create or connect the Google Sheets data source used by the app.
3. Deploy the project as a Web App.
4. Configure your users, settings, and item master data.
5. Start recording purchases and sales for your pharmacy operations.

## Use Cases

- Pharmacy inventory monitoring
- Medicine stock control
- Expiry tracking for healthcare products
- Sales and purchase reporting
- Small to medium healthcare inventory management
- Internal stock operations for clinic or pharmacy stores

## Notes

This project is designed for operational use in a Google Workspace environment and provides a practical alternative to a full custom backend for smaller pharmacy or healthcare teams that want a spreadsheet-backed system with a web interface.

## License

This project is provided as a code sample for practical use. Please review and adapt it to your organization’s compliance and operational requirements before production deployment.
