import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import { generate } from 'generate-password';
import puppeteer from 'puppeteer';
import { createRunner, PuppeteerRunnerExtension } from '@puppeteer/replay';
import winston from 'winston';

// Configure Winston logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json()
    ),
    defaultMeta: { service: 'akeyless-custom-ui-rotator' },
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

logger.info('Starting application');

const EXPECTED_ACCESS_ID = process.env.GW_ACCESS_ID;

if (!EXPECTED_ACCESS_ID) {
    logger.error('GW_ACCESS_ID environment variable is not set');
    process.exit(1);
}

let chromiumReady = false;

// Function to check Chromium availability
async function checkChromium() {
    logger.debug('Checking Chromium availability');
    try {
        const browser = await puppeteer.launch({
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: 'new'
        });
        await browser.close();
        chromiumReady = true;
        logger.info('Chromium is ready');
    } catch (error) {
        logger.error('Chromium check failed', { error: error.message, stack: error.stack });
        chromiumReady = false;
    }
}

// Periodically check Chromium availability
setInterval(checkChromium, 60000); // Check every minute
checkChromium(); // Initial check

// Simple readiness probe endpoint
app.get('/ready', (req, res) => {
    logger.debug('Readiness probe called');
    if (chromiumReady) {
        logger.info('Readiness probe: Ready');
        res.status(200).json({ status: 'Ready' });
    } else {
        logger.warn('Readiness probe: Not Ready');
        res.status(503).json({ status: 'Not Ready' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    logger.debug('Health check called');
    res.status(200).json({ status: 'OK' });
});

// Rotation endpoint
app.post('/rotate', async (req, res) => {
    logger.info('Rotation request received');
    const akeylessCreds = req.headers['akeylesscreds'];
    
    if (!akeylessCreds) {
        logger.error('Missing AkeylessCreds header');
        return res.status(401).json({ error: 'Missing AkeylessCreds header' });
    }

    try {
        logger.debug('Validating AkeylessCreds');
        // Validate the AkeylessCreds
        const validationResponse = await axios.post('https://auth.akeyless.io/validate-producer-credentials', {
            creds: akeylessCreds,
            expected_access_id: EXPECTED_ACCESS_ID
        });

        if (validationResponse.status !== 200) {
            logger.error('Invalid AkeylessCreds', { status: validationResponse.status });
            return res.status(401).json({ error: 'Invalid AkeylessCreds' });
        }

        logger.info('AkeylessCreds validated successfully');
        
        // Log the raw payload for debugging
        logger.debug('Raw payload received', { rawPayload: req.body.payload });

        // Parse the payload
        const payload = JSON.parse(req.body.payload);
        logger.debug('Parsed payload', { username: payload.username, hasPassword: !!payload.password });

        // Generate a new password
        const newPassword = generate(payload.passwordOptions);
        logger.info('New password generated');

        // Update the recording with current and new credentials
        const updatedRecording = updateRecordingCredentials(
            payload.recording, 
            payload.username, 
            payload.password, 
            newPassword, 
            payload.usernameMappings, 
            payload.passwordMappings, 
            payload.newPasswordMappings
        );
        logger.info('Recording updated with new credentials');

        // Execute the updated recording using puppeteer-replay
        logger.debug('Executing updated recording');
        const executionResults = await executeRecording(updatedRecording);
        logger.info('Recording execution completed', { steps: executionResults.length });

        // Prepare the new payload
        const newPayload = {
            ...payload,
            password: newPassword,
            recording: updatedRecording,
            executionResults: executionResults
        };

        logger.info('Rotation completed successfully');
        // Return the new payload
        res.json({
            payload: JSON.stringify(newPayload)
        });
    } catch (error) {
        logger.error('Error during rotation', { error: error.message, stack: error.stack });
        // In case of error, we still need to return a payload
        const errorPayload = {
            error: 'Internal server error',
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        };
        res.status(500).json({ 
            payload: JSON.stringify(errorPayload)
        });
    }
});

function updateRecordingCredentials(recording, username, password, newPassword, usernameMappings, passwordMappings, newPasswordMappings) {
    logger.debug('Updating recording credentials');
    return {
        ...recording,
        steps: recording.steps.map(step => {
            if (step.type === 'change') {
                const selectorsString = JSON.stringify(step.selectors);
                if (usernameMappings.includes(selectorsString)) {
                    logger.debug('Updating username in recording');
                    return { ...step, value: username };
                } else if (passwordMappings.includes(selectorsString)) {
                    logger.debug('Updating current password in recording');
                    return { ...step, value: password };
                } else if (newPasswordMappings.includes(selectorsString)) {
                    logger.debug('Updating new password in recording');
                    return { ...step, value: newPassword };
                }
            }
            return step;
        })
    };
}

class DetailedExtension extends PuppeteerRunnerExtension {
    stepResults = [];

    async beforeAllSteps(flow) {
        await super.beforeAllSteps(flow);
        logger.debug('Starting recording playback');
    }

    async beforeEachStep(step, flow) {
        await super.beforeEachStep(step, flow);
        logger.debug(`Executing step: ${step.type}`);
    }

    async runStep(step, flow) {
        const startTime = Date.now();
        try {
            await super.runStep(step, flow)
            this.stepResults.push({ step: step.type, status: 'Success', duration: Date.now() - startTime });
            logger.debug(`Step ${step.type} completed successfully`);
        } catch (error) {
            logger.error(`Step ${step.type} failed`, { error: error.message });
            this.stepResults.push({ step: step.type, status: 'Failure', duration: Date.now() - startTime, error: error.message });
            throw error;
        }
    }

    async afterAllSteps(flow) {
        await super.afterAllSteps(flow);
        logger.debug('Finished recording playback');
        logger.info('Playback Results:', { results: this.stepResults });
    }
}

async function executeRecording(recording) {
    logger.debug('Launching browser for recording execution');
    const browser = await puppeteer.launch({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: 'new'
    });
    const page = await browser.newPage();

    const extension = new DetailedExtension(browser, page);
    const runner = await createRunner(recording, extension);

    try {
        logger.info('Starting recording execution');
        await runner.run();
        logger.info('Recording execution completed successfully');
        return extension.stepResults;
    } catch (error) {
        logger.error('Error during recording execution', { error: error.message, stack: error.stack });
        throw error;
    } finally {
        await browser.close();
        logger.debug('Browser closed after recording execution');
    }
}

app.listen(port, () => {
    logger.info(`Server running on port: ${port}`);
});

// Error handling middleware
app.use((err, req, res, next) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});